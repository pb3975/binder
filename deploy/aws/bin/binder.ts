// CDK app: cdk deploy -c key=value ... (keys in lib/config.ts, explained in docs/aws.md).
import { readFileSync } from "node:fs";
import * as cdk from "aws-cdk-lib";
import { BinderStack } from "../lib/binder-stack.ts";
import { CONTEXT_KEYS, ConfigError, parseConfig, type Context } from "../lib/config.ts";

// The default image tag is the Binder version in this checkout.
const { version } = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));

const app = new cdk.App();
const ctx: Context = Object.fromEntries(CONTEXT_KEYS.map((k) => [k, app.node.tryGetContext(k)]));

let config;
try {
  config = parseConfig(ctx, { imageTag: version });
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  console.error(`binder: ${e.message}`);
  process.exit(1);
}

new BinderStack(app, "Binder", {
  config,
  description: "Binder: a private library for the pages your agents build (docs/aws.md)",
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
