// Marketplace pre-flight for the synthesized template: the things reviewers reject first.
import { readFileSync } from "node:fs";
const t = JSON.parse(readFileSync(process.argv[2], "utf8"));
const problems = [];
const res = Object.entries(t.Resources);
if (JSON.stringify(t).includes("cdk-hnb659fds") || t.Parameters?.BootstrapVersion) problems.push("template references CDK bootstrap assets (must be self-contained)");
for (const [name, r] of Object.entries(t.Resources)) if (r.Type === "AWS::Lambda::Function" || r.Type.startsWith("Custom::")) problems.push(`${name}: custom resource / Lambda needs an asset bucket (${r.Type})`);
for (const [name, r] of res) {
  if (r.Type === "AWS::IAM::Role" && JSON.stringify(r.Properties.AssumeRolePolicyDocument).includes('"AWS"')) problems.push(`${name}: role trusts an AWS principal`);
  if (r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::Role") {
    const docs = [r.Properties.PolicyDocument, ...(r.Properties.Policies ?? []).map((p) => p.PolicyDocument)].filter(Boolean);
    for (const d of docs) for (const st of d.Statement) {
      const actions = [].concat(st.Action ?? []);
      if (actions.includes("*")) problems.push(`${name}: Action "*"`);
      if (actions.some((a) => /^(iam|sts):/.test(a) && a !== "sts:AssumeRole")) problems.push(`${name}: IAM mutation action ${actions.join(",")}`);
    }
  }
  if (r.Type === "AWS::ElasticLoadBalancingV2::Listener" && r.Properties.Protocol === "HTTP" && r.Properties.DefaultActions?.[0]?.Type !== "redirect") problems.push(`${name}: plain HTTP listener that does not redirect`);
  if (r.Type === "AWS::ECS::TaskDefinition") {
    for (const c of r.Properties.ContainerDefinitions) {
      const env = Object.fromEntries((c.Environment ?? []).map((e) => [e.Name, e.Value]));
      for (const k of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|KEY$/i.test(k) && !/VERSION/.test(k)) problems.push(`${name}: secret-looking plain env var ${k}`);
      if (!c.Secrets?.some((s) => s.Name === "ADMIN_TOKEN")) problems.push(`${name}: ADMIN_TOKEN is not injected from Secrets Manager`);
      if (!c.HealthCheck) problems.push(`${name}: container has no health check`);
    }
  }
  if (r.Type === "AWS::EC2::SecurityGroupIngress" || r.Type === "AWS::EC2::SecurityGroup") {
    for (const i of r.Properties.SecurityGroupIngress ?? []) if (i.CidrIp === "0.0.0.0/0" && !(i.FromPort === 443 || i.FromPort === 80)) problems.push(`${name}: world-open ingress on port ${i.FromPort}`);
  }
}
const params = Object.keys(t.Parameters ?? {});
for (const must of ["CertificateArn", "AdminAllowedCidrs", "MarketplaceProductCode", "ContainerImage"]) if (!params.includes(must)) problems.push(`missing parameter ${must}`);
if (!t.Metadata?.["AWS::CloudFormation::Interface"]) problems.push("no parameter groups (AWS::CloudFormation::Interface)");
console.log(problems.length ? `FAIL\n - ${problems.join("\n - ")}` : `OK: ${res.length} resources, ${params.length} parameters, no findings`);
process.exit(problems.length ? 1 : 0);
