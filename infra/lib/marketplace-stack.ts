/**
 * AWS Marketplace container product: a self-contained, parameterised CloudFormation
 * template that a buyer launches into their own account from the listing page.
 *
 * Differences from the dev GatewayStack:
 *   - every deployment choice is a CloudFormation Parameter (no config file, no CDK context)
 *   - image comes from the Marketplace ECR repository (parameter), not a local Docker build
 *   - HTTPS is mandatory (ACM certificate parameter); HTTP only redirects
 *   - tasks run in private subnets behind a NAT gateway; only the ALB is public
 *   - the admin UI is reachable only from an operator-supplied CIDR (default: disabled)
 *   - the admin token is generated into Secrets Manager, never typed into a parameter
 *   - the task calls Marketplace RegisterUsage on start (hourly billing / entitlement check)
 *   - IAM is scoped: Bedrock Mantle project, Anthropic foundation models, inference profiles,
 *     the two DynamoDB tables; optional bring-your-own task role and permissions boundary
 *
 * Synthesize with:  npx cdk synth -c marketplace=1 tokener-marketplace > dist/tokener-marketplace.template.json
 */
import { CfnCondition, CfnOutput, CfnParameter, Duration, Fn, RemovalPolicy, Stack, Tags, type StackProps, Aws } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct, IConstruct } from "constructs";

export interface MarketplaceStackProps extends StackProps {
  /** Baked into the template as the default image; the Marketplace listing pins the real URI per version. */
  defaultImage?: string;
  productVersion?: string;
}

/** Attach a CloudFormation Condition to every CFN resource under a construct (L2 escape hatch). */
function conditionAll(scope: IConstruct, condition: CfnCondition): void {
  for (const n of scope.node.findAll()) {
    const r = n.node.defaultChild as { cfnOptions?: { condition?: CfnCondition } } | undefined;
    if (r?.cfnOptions) r.cfnOptions.condition = condition;
  }
}

export class MarketplaceStack extends Stack {
  constructor(scope: Construct, id: string, props: MarketplaceStackProps = {}) {
    super(scope, id, props);
    const ns = "tokener";

    // ------------------------------------------------------------------ parameters
    const pImage = new CfnParameter(this, "ContainerImage", {
      type: "String",
      default: props.defaultImage ?? "709825985650.dkr.ecr.us-east-1.amazonaws.com/archeon/tokener:latest",
      description: "Container image URI (AWS Marketplace ECR). Leave the default unless support tells you otherwise.",
    });
    const pProductCode = new CfnParameter(this, "MarketplaceProductCode", {
      type: "String",
      default: "",
      description: "AWS Marketplace product code for usage registration. Pre-filled by the listing; leave empty only for BYOL / evaluation builds.",
    });
    const pCert = new CfnParameter(this, "CertificateArn", {
      type: "String",
      allowedPattern: "^arn:aws[a-z-]*:acm:[a-z0-9-]+:[0-9]{12}:certificate/.+$",
      constraintDescription: "must be an ACM certificate ARN in this region",
      description: "ACM certificate ARN for the gateway hostname. HTTPS is mandatory: developer tokens travel in this connection.",
    });
    const pDomain = new CfnParameter(this, "DomainName", {
      type: "String",
      default: "",
      description: "Hostname developers will use (e.g. claude-gw.example.com). Create a DNS CNAME to the LoadBalancerDns output after deployment.",
    });
    const pAdminCidr = new CfnParameter(this, "AdminAllowedCidrs", {
      type: "String",
      default: "",
      allowedPattern: "^$|^([0-9]{1,3}\\.){3}[0-9]{1,3}/[0-9]{1,2}(,([0-9]{1,3}\\.){3}[0-9]{1,3}/[0-9]{1,2})*$",
      constraintDescription: "comma-separated IPv4 CIDRs, or empty to disable the admin UI",
      description: "Comma-separated CIDRs allowed to reach the admin UI and API (/admin). Empty disables /admin at the load balancer (returns 403).",
    });
    const pAlertEmail = new CfnParameter(this, "AlertEmail", { type: "String", default: "", description: "Optional e-mail for CloudWatch alarms (spend, errors, unhealthy tasks). You will receive an SNS confirmation." });
    const pDesired = new CfnParameter(this, "DesiredCount", { type: "Number", default: 2, minValue: 1, maxValue: 6, description: "Number of gateway tasks. 2 gives zero-downtime deploys; 1 is enough for evaluation." });
    const pNat = new CfnParameter(this, "NatGateways", { type: "String", default: "1", allowedValues: ["1", "2"], description: "NAT gateways for the private subnets. 1 is cheaper; 2 survives an AZ outage." });
    const pMode = new CfnParameter(this, "UpstreamMode", { type: "String", default: "mantle", allowedValues: ["mantle", "runtime"], description: "Bedrock API used by default: mantle (Anthropic Messages API on Bedrock) or runtime (classic InvokeModel). Changeable later in the admin UI." });
    const pPrefix = new CfnParameter(this, "BedrockProfilePrefix", { type: "String", default: "us", allowedValues: ["us", "global", "eu", "apac", "none"], description: "Inference-profile prefix for runtime mode. Pick the one matching your region's cross-region profiles." });
    const pDailyAlert = new CfnParameter(this, "TeamDailyAlertUsd", { type: "Number", default: 150, minValue: 1, description: "Alarm when the team's estimated daily Bedrock spend (USD) crosses this value." });
    const pTaskRole = new CfnParameter(this, "ExistingTaskRoleArn", { type: "String", default: "", description: "Optional: ARN of an IAM role you manage for the gateway tasks. Empty = the stack creates a least-privilege role. See the documentation for the required permissions." });
    const pBoundary = new CfnParameter(this, "PermissionsBoundaryArn", { type: "String", default: "", description: "Optional: permissions boundary policy ARN applied to every IAM role this stack creates." });

    this.templateOptions.metadata = {
      "AWS::CloudFormation::Interface": {
        ParameterGroups: [
          { Label: { default: "Endpoint" }, Parameters: [pCert.logicalId, pDomain.logicalId, pAdminCidr.logicalId] },
          { Label: { default: "Bedrock" }, Parameters: [pMode.logicalId, pPrefix.logicalId] },
          { Label: { default: "Capacity and cost" }, Parameters: [pDesired.logicalId, pNat.logicalId, pDailyAlert.logicalId, pAlertEmail.logicalId] },
          { Label: { default: "Security (optional)" }, Parameters: [pTaskRole.logicalId, pBoundary.logicalId] },
          { Label: { default: "Marketplace (do not change)" }, Parameters: [pImage.logicalId, pProductCode.logicalId] },
        ],
        ParameterLabels: {
          [pCert.logicalId]: { default: "ACM certificate ARN" },
          [pDomain.logicalId]: { default: "Gateway hostname" },
          [pAdminCidr.logicalId]: { default: "Admin UI allowed CIDRs" },
          [pMode.logicalId]: { default: "Default Bedrock API" },
          [pPrefix.logicalId]: { default: "Inference-profile prefix" },
          [pDesired.logicalId]: { default: "Gateway tasks" },
          [pNat.logicalId]: { default: "NAT gateways" },
          [pDailyAlert.logicalId]: { default: "Daily spend alarm (USD)" },
          [pAlertEmail.logicalId]: { default: "Alert e-mail" },
          [pTaskRole.logicalId]: { default: "Existing task role ARN" },
          [pBoundary.logicalId]: { default: "Permissions boundary ARN" },
          [pImage.logicalId]: { default: "Container image" },
          [pProductCode.logicalId]: { default: "Marketplace product code" },
        },
      },
    };

    const hasAdminCidr = new CfnCondition(this, "HasAdminCidr", { expression: Fn.conditionNot(Fn.conditionEquals(pAdminCidr.valueAsString, "")) });
    const hasAlertEmail = new CfnCondition(this, "HasAlertEmail", { expression: Fn.conditionNot(Fn.conditionEquals(pAlertEmail.valueAsString, "")) });
    const hasDomain = new CfnCondition(this, "HasDomainName", { expression: Fn.conditionNot(Fn.conditionEquals(pDomain.valueAsString, "")) });
    const hasTaskRole = new CfnCondition(this, "HasExistingTaskRole", { expression: Fn.conditionNot(Fn.conditionEquals(pTaskRole.valueAsString, "")) });
    const hasBoundary = new CfnCondition(this, "HasPermissionsBoundary", { expression: Fn.conditionNot(Fn.conditionEquals(pBoundary.valueAsString, "")) });
    const twoNats = new CfnCondition(this, "TwoNatGateways", { expression: Fn.conditionEquals(pNat.valueAsString, "2") });

    Tags.of(this).add("Product", "tokener");
    if (props.productVersion) Tags.of(this).add("ProductVersion", props.productVersion);

    // ------------------------------------------------------------------ network: ALB public, tasks private
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 2,
      // The default-SG lockdown is a Lambda-backed custom resource that needs a CDK asset bucket; buyers'
      // accounts have none. Nothing in this stack uses the default security group.
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });
    // Second NAT gateway (and its EIP) only when the operator asked for two; the second private
    // subnet then routes through NAT #1 instead.
    const nats = vpc.node.findAll().filter((n) => n instanceof ec2.CfnNatGateway) as ec2.CfnNatGateway[];
    const eips = vpc.node.findAll().filter((n) => n instanceof ec2.CfnEIP) as ec2.CfnEIP[];
    if (nats.length === 2 && eips.length === 2) {
      nats[1].cfnOptions.condition = twoNats;
      eips[1].cfnOptions.condition = twoNats;
      const privateRoutes = vpc.node.findAll().filter((n) => n instanceof ec2.CfnRoute && (n as ec2.CfnRoute).natGatewayId !== undefined) as ec2.CfnRoute[];
      for (const r of privateRoutes) {
        if (r.natGatewayId === nats[1].ref) r.natGatewayId = Fn.conditionIf(twoNats.logicalId, nats[1].ref, nats[0].ref).toString();
      }
    }

    // ------------------------------------------------------------------ data
    const keys = new dynamodb.TableV2(this, "Keys", {
      partitionKey: { name: "keyHash", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    const usage = new dynamodb.TableV2(this, "Usage", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ------------------------------------------------------------------ secrets
    const adminSecret = new secretsmanager.Secret(this, "AdminToken", {
      description: "tokener admin UI bearer token (generated at deploy time)",
      generateSecretString: { excludePunctuation: true, includeSpace: false, passwordLength: 40 },
    });

    // ------------------------------------------------------------------ IAM
    const boundaryArn = Fn.conditionIf(hasBoundary.logicalId, pBoundary.valueAsString, Aws.NO_VALUE).toString();
    const createdTaskRole = new iam.Role(this, "TaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "tokener gateway task role: Bedrock inference, model catalog, usage tables, Marketplace metering",
    });
    createdTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "BedrockMantleMessagesApi",
        actions: ["bedrock-mantle:CreateInference", "bedrock-mantle:CountTokens"],
        resources: [`arn:${Aws.PARTITION}:bedrock-mantle:${Aws.REGION}:${Aws.ACCOUNT_ID}:project/*`],
      }),
    );
    createdTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "BedrockRuntimeInvoke",
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:CountTokens"],
        resources: [`arn:${Aws.PARTITION}:bedrock:*::foundation-model/anthropic.*`, `arn:${Aws.PARTITION}:bedrock:*:${Aws.ACCOUNT_ID}:inference-profile/*`],
      }),
    );
    createdTaskRole.addToPolicy(
      new iam.PolicyStatement({ sid: "BedrockModelCatalog", actions: ["bedrock:ListFoundationModels", "bedrock:ListInferenceProfiles"], resources: ["*"] }),
    );
    createdTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AnthropicModelSubscriptionViaBedrock",
        actions: ["aws-marketplace:ViewSubscriptions", "aws-marketplace:Subscribe"],
        resources: ["*"],
        conditions: { StringEquals: { "aws:CalledViaLast": "bedrock.amazonaws.com" } },
      }),
    );
    createdTaskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AWSMarketplaceMeteringRegisterUsage"));
    keys.grantReadWriteData(createdTaskRole);
    usage.grantReadWriteData(createdTaskRole);
    // The role is created unconditionally: ECS adds DependsOn edges from the service to the task role and
    // CloudFormation rejects DependsOn on a resource whose Condition is false. With ExistingTaskRoleArn the
    // created role is simply left unused (no cost, no trust outside the account).
    (createdTaskRole.node.defaultChild as iam.CfnRole).permissionsBoundary = boundaryArn;

    const executionRole = new iam.Role(this, "ExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "tokener task execution role: pull the Marketplace image, write logs, read the admin token",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy")],
    });
    adminSecret.grantRead(executionRole);
    (executionRole.node.defaultChild as iam.CfnRole).permissionsBoundary = boundaryArn;

    // ------------------------------------------------------------------ compute
    const cluster = new ecs.Cluster(this, "Cluster", { vpc, containerInsightsV2: ecs.ContainerInsights.ENABLED });
    const logGroup = new logs.LogGroup(this, "Logs", { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: RemovalPolicy.DESTROY });
    const certificate = acm.Certificate.fromCertificateArn(this, "Cert", pCert.valueAsString);

    const taskDef = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole: createdTaskRole,
      executionRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    // Bring-your-own role: swap the ARN at the CloudFormation level.
    (taskDef.node.defaultChild as ecs.CfnTaskDefinition).taskRoleArn = Fn.conditionIf(hasTaskRole.logicalId, pTaskRole.valueAsString, createdTaskRole.roleArn).toString();

    taskDef.addContainer("gateway", {
      image: ecs.ContainerImage.fromRegistry(pImage.valueAsString),
      portMappings: [{ containerPort: 8080 }],
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "gateway" }),
      environment: {
        PORT: "8080",
        AWS_REGION: Aws.REGION,
        KEYS_TABLE: keys.tableName,
        USAGE_TABLE: usage.tableName,
        METRICS_NAMESPACE: ns,
        NODE_OPTIONS: "--max-old-space-size=768",
        UPSTREAM_MODE: pMode.valueAsString,
        BEDROCK_PROFILE_PREFIX: pPrefix.valueAsString,
        MARKETPLACE_PRODUCT_CODE: pProductCode.valueAsString,
        MARKETPLACE_PUBLIC_KEY_VERSION: "1",
        BRIDGE_BEDROCK: "true",
        EFFORT_MODE: "off",
        BUDGET_ACTION: "warn",
      },
      secrets: { ADMIN_TOKEN: ecs.Secret.fromSecretsManager(adminSecret) },
      healthCheck: { command: ["CMD-SHELL", "wget -qO- http://127.0.0.1:8080/health || exit 1"], interval: Duration.seconds(30), timeout: Duration.seconds(5), retries: 3, startPeriod: Duration.seconds(20) },
    });

    const svc = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "Service", {
      cluster,
      taskDefinition: taskDef,
      desiredCount: pDesired.valueAsNumber,
      assignPublicIp: false,
      taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      publicLoadBalancer: true,
      certificate,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      redirectHTTP: true,
      sslPolicy: elbv2.SslPolicy.TLS13_RES,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: Duration.seconds(60),
    });
    svc.targetGroup.configureHealthCheck({ path: "/health", interval: Duration.seconds(15), healthyThresholdCount: 2, unhealthyThresholdCount: 3 });
    svc.targetGroup.setAttribute("deregistration_delay.timeout_seconds", "30");
    svc.loadBalancer.setAttribute("idle_timeout.timeout_seconds", "900");
    svc.loadBalancer.setAttribute("routing.http.drop_invalid_header_fields.enabled", "true");

    // /admin* : allowed only from the operator CIDRs; otherwise a fixed 403 at the load balancer.
    // The allow rule always exists (the ECS service depends on listener rules); with no CIDRs it matches
    // only 127.0.0.1/32, which never arrives at an internet-facing ALB, so the deny rule wins.
    const adminCidrs = Fn.split(",", Fn.conditionIf(hasAdminCidr.logicalId, pAdminCidr.valueAsString, "127.0.0.1/32").toString());
    new elbv2.ApplicationListenerRule(this, "AdminAllow", {
      listener: svc.listener,
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/admin", "/admin/*"]), elbv2.ListenerCondition.sourceIps(adminCidrs)],
      action: elbv2.ListenerAction.forward([svc.targetGroup]),
    });
    new elbv2.ApplicationListenerRule(this, "AdminDeny", {
      listener: svc.listener,
      priority: 20,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/admin", "/admin/*"])],
      action: elbv2.ListenerAction.fixedResponse(403, { contentType: "application/json", messageBody: '{"error":"admin UI is restricted to the AdminAllowedCidrs of this deployment"}' }),
    });

    const scaling = svc.service.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 6 });
    scaling.scaleOnCpuUtilization("Cpu", { targetUtilizationPercent: 60 });

    // ------------------------------------------------------------------ observability
    const metric = (name: string, stat = "Sum") => new cw.Metric({ namespace: ns, metricName: name, statistic: stat, period: Duration.hours(1) });
    const dashboard = new cw.Dashboard(this, "Dashboard", { dashboardName: `${Aws.STACK_NAME}-usage` });
    dashboard.addWidgets(
      new cw.GraphWidget({
        title: "Estimated cost per developer ($/h)",
        left: [new cw.MathExpression({ expression: `SEARCH('{${ns},Developer} MetricName="EstimatedCostUsd"', 'Sum', 3600)`, label: "", period: Duration.hours(1) })],
        width: 12,
        height: 8,
      }),
      new cw.GraphWidget({ title: "Tokens", left: [metric("InputTokens"), metric("CacheReadTokens"), metric("CacheWriteTokens"), metric("OutputTokens")], width: 12, height: 8 }),
    );
    dashboard.addWidgets(
      new cw.GraphWidget({
        title: "Cache hit %",
        left: [new cw.MathExpression({ expression: "100 * cr / (cr + inp + cw)", usingMetrics: { cr: metric("CacheReadTokens"), inp: metric("InputTokens"), cw: metric("CacheWriteTokens") }, label: "hit %", period: Duration.hours(1) })],
        leftYAxis: { min: 0, max: 100 },
        width: 8,
        height: 6,
      }),
      new cw.GraphWidget({ title: "Latency p50 / p95 (ms)", left: [metric("LatencyMs", "p50"), metric("LatencyMs", "p95")], width: 8, height: 6 }),
      new cw.GraphWidget({ title: "Errors", left: [metric("Errors")], width: 8, height: 6 }),
    );

    const topic = new sns.Topic(this, "Alerts", { displayName: "tokener alerts" });
    const sub = topic.addSubscription(new subs.EmailSubscription(pAlertEmail.valueAsString));
    conditionAll(sub, hasAlertEmail);
    const alarm = (id: string, m: cw.Metric, threshold: number, evaluationPeriods: number, description: string) => {
      const a = new cw.Alarm(this, id, { metric: m, threshold, evaluationPeriods, treatMissingData: cw.TreatMissingData.NOT_BREACHING, alarmDescription: description });
      a.addAlarmAction(new cwActions.SnsAction(topic));
      return a;
    };
    alarm("HighErrorRate", metric("Errors").with({ period: Duration.minutes(5) }), 20, 2, "More than 20 failed model requests in 5 minutes");
    alarm("DailySpend", metric("EstimatedCostUsd").with({ period: Duration.hours(24) }), pDailyAlert.valueAsNumber, 1, "Estimated team spend for the day crossed the alert threshold");
    alarm("Unhealthy", svc.targetGroup.metrics.unhealthyHostCount({ period: Duration.minutes(1) }), 1, 3, "A gateway task is failing its health check");
    // Tasks that cannot register with Marketplace exit on purpose; surface that instead of letting ECS restart-loop silently.
    const exitFilter = new logs.MetricFilter(this, "MarketplaceExitFilter", {
      logGroup,
      metricNamespace: ns,
      metricName: "MarketplaceRegistrationFailures",
      filterPattern: logs.FilterPattern.stringValue("$.event", "=", "marketplace_exit"),
      metricValue: "1",
      defaultValue: 0,
    });
    alarm("MarketplaceRegistration", exitFilter.metric({ statistic: "Sum", period: Duration.minutes(5) }), 1, 1, "A gateway task exited because AWS Marketplace usage registration failed (subscription or IAM problem)");

    // ------------------------------------------------------------------ outputs
    const host = Fn.conditionIf(hasDomain.logicalId, pDomain.valueAsString, svc.loadBalancer.loadBalancerDnsName).toString();
    new CfnOutput(this, "GatewayUrl", { value: `https://${host}`, description: "ANTHROPIC_BASE_URL for developers" });
    new CfnOutput(this, "LoadBalancerDns", { value: svc.loadBalancer.loadBalancerDnsName, description: "Point your DNS CNAME here" });
    new CfnOutput(this, "AdminUrl", { value: `https://${host}/admin/`, description: "Admin UI (reachable from AdminAllowedCidrs only)" });
    new CfnOutput(this, "AdminTokenSecretArn", { value: adminSecret.secretArn, description: "Secrets Manager secret holding the admin token" });
    new CfnOutput(this, "AdminTokenCommand", { value: `aws secretsmanager get-secret-value --secret-id ${adminSecret.secretArn} --query SecretString --output text`, description: "Retrieve the admin token" });
    new CfnOutput(this, "KeysTableName", { value: keys.tableName });
    new CfnOutput(this, "UsageTableName", { value: usage.tableName });
    new CfnOutput(this, "DashboardName", { value: dashboard.dashboardName });
    new CfnOutput(this, "LogGroupName", { value: logGroup.logGroupName });
    new CfnOutput(this, "TaskRoleArn", { value: Fn.conditionIf(hasTaskRole.logicalId, pTaskRole.valueAsString, createdTaskRole.roleArn).toString(), description: "Role that calls Bedrock" });
  }
}
