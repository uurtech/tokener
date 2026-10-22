import { fileURLToPath } from "node:url";
import path from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
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
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import type { Construct } from "constructs";

export interface GatewayConfigFile {
  stackName?: string;
  desiredCount?: number;
  cpu?: number;
  memoryMiB?: number;
  domainName?: string;
  certificateArn?: string;
  alertEmail?: string;
  /** Enables the /admin UI and API. Empty disables them. */
  adminToken?: string;
  env?: Record<string, string>;
}

export interface GatewayStackProps extends StackProps {
  config: GatewayConfigFile;
}

export class GatewayStack extends Stack {
  constructor(scope: Construct, id: string, props: GatewayStackProps) {
    super(scope, id, props);
    const c = props.config;
    const ns = c.env?.METRICS_NAMESPACE ?? "ClaudeGateway";

    // --- Network: public subnets only, no NAT gateway (saves ~$35/mo per AZ).
    // Tasks get public IPs; the security group only allows traffic from the ALB.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    // --- Data
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

    // --- Compute
    const cluster = new ecs.Cluster(this, "Cluster", { vpc, containerInsightsV2: ecs.ContainerInsights.ENABLED });
    const logGroup = new logs.LogGroup(this, "Logs", { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: RemovalPolicy.DESTROY });

    const here = path.dirname(fileURLToPath(import.meta.url));
    const image = ecs.ContainerImage.fromAsset(path.join(here, "..", "..", "gateway"), { platform: Platform.LINUX_AMD64 });

    const certificate = c.certificateArn ? acm.Certificate.fromCertificateArn(this, "Cert", c.certificateArn) : undefined;

    const env: Record<string, string> = {
      PORT: "8080",
      AWS_REGION: this.region,
      KEYS_TABLE: keys.tableName,
      USAGE_TABLE: usage.tableName,
      METRICS_NAMESPACE: ns,
      NODE_OPTIONS: "--max-old-space-size=768",
    };
    for (const [k, v] of Object.entries(c.env ?? {})) if (v !== "") env[k] = v;
    if (c.adminToken) env.ADMIN_TOKEN = c.adminToken;

    const svc = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "Service", {
      cluster,
      cpu: c.cpu ?? 512,
      memoryLimitMiB: c.memoryMiB ?? 1024,
      desiredCount: c.desiredCount ?? 2,
      assignPublicIp: true,
      taskSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      publicLoadBalancer: true,
      certificate,
      protocol: certificate ? elbv2.ApplicationProtocol.HTTPS : elbv2.ApplicationProtocol.HTTP,
      redirectHTTP: !!certificate,
      domainName: c.domainName || undefined,
      // domainZone intentionally omitted: create the DNS record yourself (CNAME -> ALB DNS).
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: Duration.seconds(30),
      taskImageOptions: {
        image,
        containerPort: 8080,
        environment: env,
        logDriver: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "gateway" }),
      },
    });

    svc.targetGroup.configureHealthCheck({ path: "/health", interval: Duration.seconds(15), healthyThresholdCount: 2, unhealthyThresholdCount: 3 });
    svc.targetGroup.setAttribute("deregistration_delay.timeout_seconds", "30");
    // Long model turns: keep idle connections open well beyond the 60s default.
    svc.loadBalancer.setAttribute("idle_timeout.timeout_seconds", "900");

    const scaling = svc.service.autoScaleTaskCount({ minCapacity: c.desiredCount ?? 2, maxCapacity: 6 });
    scaling.scaleOnCpuUtilization("Cpu", { targetUtilizationPercent: 60 });

    // --- IAM: the task role is the only principal that can call Bedrock.
    svc.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "BedrockMessagesEndpoint",
        actions: ["bedrock-mantle:CreateInference", "bedrock-mantle:CountTokens"],
        resources: ["*"],
      }),
    );
    // Classic Bedrock Runtime API (admin UI: Upstream API = runtime). Profiles need both the profile and the
    // underlying foundation-model ARNs in every region the profile may route to, hence the region wildcards.
    svc.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "BedrockRuntimeInvoke",
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:CountTokens"],
        resources: ["arn:aws:bedrock:*::foundation-model/anthropic.*", `arn:aws:bedrock:*:${this.account}:inference-profile/*`],
      }),
    );
    // Live model catalog (/v1/models and the admin Models tab): read-only control-plane listing.
    svc.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "BedrockModelCatalog",
        actions: ["bedrock:ListFoundationModels", "bedrock:ListInferenceProfiles"],
        resources: ["*"],
      }),
    );
    // Marketplace subscription is needed the first time a model is invoked in the account.
    svc.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "MarketplaceViaBedrock",
        actions: ["aws-marketplace:ViewSubscriptions", "aws-marketplace:Subscribe"],
        resources: ["*"],
        conditions: { StringEquals: { "aws:CalledViaLast": "bedrock.amazonaws.com" } },
      }),
    );
    keys.grantReadWriteData(svc.taskDefinition.taskRole); // admin UI creates/revokes developer keys
    usage.grantReadWriteData(svc.taskDefinition.taskRole);

    // --- Observability
    const metric = (name: string, stat = "Sum", dims?: Record<string, string>) =>
      new cw.Metric({ namespace: ns, metricName: name, statistic: stat, period: Duration.hours(1), dimensionsMap: dims });

    const costByDev = new cw.MathExpression({
      expression: `SEARCH('{${ns},Developer} MetricName="EstimatedCostUsd"', 'Sum', 3600)`,
      label: "Cost per developer ($/h)",
      period: Duration.hours(1),
    });
    const cacheHit = new cw.MathExpression({
      expression: "100 * cr / (cr + inp + cw)",
      usingMetrics: { cr: metric("CacheReadTokens"), inp: metric("InputTokens"), cw: metric("CacheWriteTokens") },
      label: "Cache hit % (tokens)",
      period: Duration.hours(1),
    });
    const outRatio = new cw.MathExpression({
      expression: "100 * o / (cr + inp + cw)",
      usingMetrics: { o: metric("OutputTokens"), cr: metric("CacheReadTokens"), inp: metric("InputTokens"), cw: metric("CacheWriteTokens") },
      label: "Output / input %",
      period: Duration.hours(1),
    });

    const dashboard = new cw.Dashboard(this, "Dashboard", { dashboardName: `${id}-usage` });
    dashboard.addWidgets(
      new cw.GraphWidget({ title: "Estimated cost per developer", left: [costByDev], width: 12, height: 8 }),
      new cw.GraphWidget({
        title: "Tokens (all developers)",
        left: [metric("InputTokens"), metric("CacheReadTokens"), metric("CacheWriteTokens"), metric("OutputTokens")],
        width: 12,
        height: 8,
      }),
    );
    dashboard.addWidgets(
      new cw.GraphWidget({ title: "Cache hit %", left: [cacheHit], leftYAxis: { min: 0, max: 100 }, width: 8, height: 6 }),
      new cw.GraphWidget({ title: "Output/input %", left: [outRatio], width: 8, height: 6 }),
      new cw.GraphWidget({
        title: "Requests by class",
        left: [
          new cw.MathExpression({ expression: `SEARCH('{${ns},RequestClass} MetricName="Requests"', 'Sum', 3600)`, label: "", period: Duration.hours(1) }),
        ],
        width: 8,
        height: 6,
      }),
    );
    dashboard.addWidgets(
      new cw.GraphWidget({ title: "Latency p50 / p95 (ms)", left: [metric("LatencyMs", "p50"), metric("LatencyMs", "p95")], width: 8, height: 6 }),
      new cw.GraphWidget({ title: "Errors", left: [metric("Errors")], width: 8, height: 6 }),
      new cw.GraphWidget({
        title: "ALB 5xx / target 5xx",
        left: [svc.loadBalancer.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT), svc.loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT)],
        width: 8,
        height: 6,
      }),
    );
    dashboard.addWidgets(
      new cw.LogQueryWidget({
        title: "Most expensive sessions (last 24h)",
        logGroupNames: [logGroup.logGroupName],
        width: 24,
        height: 8,
        queryLines: [
          "fields @timestamp, Developer, SessionId, Model, EstimatedCostUsd, InputTokens, CacheReadTokens, OutputTokens",
          "filter ispresent(EstimatedCostUsd)",
          "stats sum(EstimatedCostUsd) as cost, count() as turns, sum(OutputTokens) as output by Developer, SessionId",
          "sort cost desc",
          "limit 20",
        ],
      }),
    );

    // --- Alerts
    const topic = new sns.Topic(this, "Alerts");
    if (c.alertEmail) topic.addSubscription(new subs.EmailSubscription(c.alertEmail));

    new cw.Alarm(this, "HighErrorRate", {
      metric: metric("Errors").with({ period: Duration.minutes(5) }),
      threshold: 20,
      evaluationPeriods: 2,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      alarmDescription: "More than 20 failed model requests in 5 minutes",
    }).addAlarmAction(new cwActions.SnsAction(topic));

    new cw.Alarm(this, "DailySpend", {
      metric: metric("EstimatedCostUsd").with({ period: Duration.hours(24) }),
      threshold: Number(c.env?.TEAM_DAILY_ALERT_USD ?? "150"),
      evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      alarmDescription: "Estimated team spend for the day crossed the alert threshold",
    }).addAlarmAction(new cwActions.SnsAction(topic));

    new cw.Alarm(this, "Unhealthy", {
      metric: svc.targetGroup.metrics.unhealthyHostCount({ period: Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 3,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cwActions.SnsAction(topic));

    // --- Outputs
    const scheme = certificate ? "https" : "http";
    new CfnOutput(this, "GatewayUrl", { value: `${scheme}://${c.domainName || svc.loadBalancer.loadBalancerDnsName}` });
    new CfnOutput(this, "LoadBalancerDns", { value: svc.loadBalancer.loadBalancerDnsName });
    new CfnOutput(this, "KeysTableName", { value: keys.tableName });
    new CfnOutput(this, "UsageTableName", { value: usage.tableName });
    new CfnOutput(this, "LogGroupName", { value: logGroup.logGroupName });
    new CfnOutput(this, "DashboardName", { value: dashboard.dashboardName });
    new CfnOutput(this, "AlertsTopicArn", { value: topic.topicArn });
  }
}
