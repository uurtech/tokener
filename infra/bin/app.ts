#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { App, CliCredentialsStackSynthesizer } from "aws-cdk-lib";
import { GatewayStack, type GatewayConfigFile } from "../lib/gateway-stack.js";
import { MarketplaceStack } from "../lib/marketplace-stack.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = new App();

if (app.node.tryGetContext("marketplace")) {
  // Parameterised, account-agnostic template for the AWS Marketplace listing (no env binding, no assets).
  const pkg = JSON.parse(readFileSync(path.join(here, "..", "..", "gateway", "package.json"), "utf8")) as { version: string };
  new MarketplaceStack(app, "tokener-marketplace", {
    description: `tokener ${pkg.version} - Claude Code to Amazon Bedrock token-optimisation gateway (ECS Fargate, ALB, DynamoDB, CloudWatch). AWS Marketplace container product.`,
    productVersion: pkg.version,
    defaultImage: app.node.tryGetContext("image") as string | undefined,
    // No bootstrap stack, no asset bucket: buyers deploy this into accounts that have never seen CDK.
    synthesizer: new CliCredentialsStackSynthesizer(),
    analyticsReporting: false,
  });
} else {
  const file = process.env.GATEWAY_CONFIG ?? path.join(here, "..", "gateway.config.json");
  const cfg = JSON.parse(readFileSync(file, "utf8")) as GatewayConfigFile;
  new GatewayStack(app, cfg.stackName ?? "ClaudeBedrockGateway", {
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1",
    },
    config: cfg,
    description: "tokener dev deployment: Claude Code -> Amazon Bedrock token-optimisation gateway (ECS Fargate + ALB + DynamoDB + CloudWatch)",
  });
}
