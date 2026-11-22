// What a team gets from `cdk deploy`, checked on the synthesized CloudFormation template.
// Synthetic values only: example.com and AWS's documentation account 123456789012.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as cdk from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { BinderStack } from "../lib/binder-stack.ts";
import { parseConfig, type Context } from "../lib/config.ts";
import { loadConfig } from "../../../src/config.ts";

// The feature flags in cdk.json change the template, so tests synthesize with them, as `cdk deploy` does.
const FLAGS = JSON.parse(readFileSync(new URL("../cdk.json", import.meta.url), "utf8")).context;
const ENV = { account: "123456789012", region: "us-east-1" };
const DOMAIN: Context = { domainName: "binder.example.com", hostedZoneId: "Z0123456789EXAMPLE" };
const OIDC_SECRET = "arn:aws:secretsmanager:us-east-1:123456789012:secret:binder/oidc-AbCdEf";
const OIDC: Context = {
  ...DOMAIN,
  auth: "oidc",
  oidcIssuer: "https://sso.example.com/realms/team",
  oidcClientId: "binder",
  oidcClientSecretArn: OIDC_SECRET,
  allowedGroups: "binder-users",
  oidcGroupsClaim: "groups",
  oidcLabel: "Keycloak",
};

// What `Vpc.fromLookup` would find for the existing-VPC test: a synthetic VPC with public and private subnets.
const VPC_ID = "vpc-0123456789abcdef0";
const subnet = (n: number, az: string) => ({
  subnetId: `subnet-0${n}23456789abcdef0`,
  cidr: `10.1.${n}.0/24`,
  availabilityZone: az,
  routeTableId: `rtb-0${n}23456789abcdef0`,
});
const VPC_LOOKUP = {
  [`vpc-provider:account=${ENV.account}:filter.vpc-id=${VPC_ID}:region=${ENV.region}:returnAsymmetricSubnets=true`]: {
    vpcId: VPC_ID,
    vpcCidrBlock: "10.1.0.0/16",
    ownerAccountId: ENV.account,
    availabilityZones: [],
    subnetGroups: [
      { name: "Public", type: "Public", subnets: [subnet(1, "us-east-1a"), subnet(2, "us-east-1b")] },
      { name: "Private", type: "Private", subnets: [subnet(3, "us-east-1a"), subnet(4, "us-east-1b")] },
    ],
  },
};

function synth(ctx: Context = {}) {
  const app = new cdk.App({ context: { ...FLAGS, ...VPC_LOOKUP } });
  const stack = new BinderStack(app, "Binder", { env: ENV, config: parseConfig(ctx, { imageTag: "9.9.9" }) });
  return { stack, template: Template.fromStack(stack) };
}

const container = (t: Template) => {
  const defs = Object.values(t.findResources("AWS::ECS::TaskDefinition"));
  expect(defs).toHaveLength(1);
  return defs[0]!.Properties.ContainerDefinitions[0];
};
const envOf = (t: Template): Record<string, unknown> =>
  Object.fromEntries(container(t).Environment.map((e: { Name: string; Value: unknown }) => [e.Name, e.Value]));
const secretNames = (t: Template): string[] => container(t).Secrets.map((s: { Name: string }) => s.Name).sort();

describe("defaults", () => {
  const { stack, template } = synth();

  test("internal load balancer, no NAT gateway, S3 gateway endpoint", () => {
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", { Scheme: "internal" });
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
    template.resourceCountIs("AWS::EC2::Subnet", 2);
    template.hasResourceProperties("AWS::EC2::VPCEndpoint", {
      VpcEndpointType: "Gateway",
      ServiceName: Match.objectLike({ "Fn::Join": Match.arrayWith([Match.arrayWith([".s3"])]) }),
    });
  });

  test("one task at a time: min 0, max 100 percent, circuit breaker with rollback", () => {
    template.hasResourceProperties("AWS::ECS::Service", {
      DesiredCount: 1,
      LaunchType: "FARGATE",
      EnableExecuteCommand: true,
      DeploymentConfiguration: {
        MinimumHealthyPercent: 0,
        MaximumPercent: 100,
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      },
    });
  });

  test("arm64 task running the slim image tagged with the repository version", () => {
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Cpu: "256",
      Memory: "512",
      RuntimePlatform: { CpuArchitecture: "ARM64", OperatingSystemFamily: "LINUX" },
    });
    expect(container(template).Image).toBe("ghcr.io/pb3975/binder:9.9.9");
    expect(container(template).PortMappings).toEqual([{ ContainerPort: 8480, Protocol: "tcp" }]);
  });

  test("bucket is private, encrypted, versioned, SSL only, and retained", () => {
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] },
        VersioningConfiguration: { Status: "Enabled" },
        LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ NoncurrentVersionExpiration: { NoncurrentDays: 30 } })]) },
      },
    });
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: "Deny", Action: "s3:*", Condition: { Bool: { "aws:SecureTransport": "false" } } }),
        ]),
      },
    });
  });

  test("task role reaches only the Binder bucket, plus the ECS Exec channel", () => {
    const bucketId = stack.getLogicalId(stack.node.findChild("Data").node.defaultChild as cdk.CfnElement);
    const roleId = stack.getLogicalId(
      stack.node.findChild("Task").node.findChild("TaskRole").node.defaultChild as cdk.CfnElement,
    );
    const policies = Object.values(template.findResources("AWS::IAM::Policy")).filter((p) =>
      JSON.stringify(p.Properties.Roles).includes(roleId),
    );
    expect(policies).toHaveLength(1);
    const statements: { Action: string[]; Resource: unknown }[] = policies[0]!.Properties.PolicyDocument.Statement;
    const bucketArn = { "Fn::GetAtt": [bucketId, "Arn"] };
    for (const s of statements) {
      const actions = [s.Action].flat();
      if (actions.every((a) => a.startsWith("ssmmessages:"))) continue;
      expect(actions.every((a) => a.startsWith("s3:"))).toBe(true);
      expect(s.Resource).toEqual([bucketArn, { "Fn::Join": ["", [bucketArn, "/binder/*"]] }]);
    }
    expect(JSON.stringify(statements)).not.toContain("secretsmanager:");
    expect(statements.filter((s) => [s.Action].flat().some((a) => a.startsWith("s3:")))).toHaveLength(1);
    // No managed policies widen the role.
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({ Statement: [Match.objectLike({ Principal: { Service: "ecs-tasks.amazonaws.com" } })] }),
      ManagedPolicyArns: Match.absent(),
    });
  });

  test("BINDER_SECRET_KEY is an ECS secret from a generated, retained secret, never plain env", () => {
    expect(secretNames(template)).toEqual(["BINDER_SECRET_KEY"]);
    expect(envOf(template)).not.toHaveProperty("BINDER_SECRET_KEY");
    template.hasResource("AWS::SecretsManager::Secret", {
      DeletionPolicy: "Retain",
      Properties: { GenerateSecretString: { PasswordLength: 64, ExcludePunctuation: true, IncludeSpace: false } },
    });
  });

  test("environment points Binder at S3 with token auth", () => {
    const env = envOf(template);
    expect(env.BINDER_AUTH).toBe("token");
    expect(env.AWS_REGION).toBe("us-east-1");
    expect(JSON.stringify(env.BINDER_STORAGE)).toContain('"s3://"');
    expect(JSON.stringify(env.BINDER_STORAGE)).toContain('"/binder"');
    expect(JSON.stringify(env.BINDER_PUBLIC_URL)).toContain("http://");
  });

  test("task accepts traffic only from the load balancer, on port 8480", () => {
    const ingress = Object.values(template.findResources("AWS::EC2::SecurityGroupIngress"));
    expect(ingress).toHaveLength(1);
    expect(ingress[0]!.Properties).toMatchObject({ FromPort: 8480, ToPort: 8480, SourceSecurityGroupId: expect.anything() });
    template.hasResourceProperties("AWS::EC2::SecurityGroup", {
      GroupDescription: "Binder task",
      SecurityGroupIngress: Match.absent(),
    });
    template.hasResourceProperties("AWS::ECS::Service", {
      NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: "ENABLED" } },
    });
  });

  test("health check on /healthz, short deregistration, long idle timeout", () => {
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      HealthCheckPath: "/healthz",
      Port: 8480,
      TargetGroupAttributes: Match.arrayWith([{ Key: "deregistration_delay.timeout_seconds", Value: "10" }]),
    });
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      LoadBalancerAttributes: Match.arrayWith([{ Key: "idle_timeout.timeout_seconds", Value: "300" }]),
    });
  });

  test("HTTP only, with a warning, and the outputs a team needs", () => {
    template.resourceCountIs("AWS::CertificateManager::Certificate", 0);
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", { Port: 80, Protocol: "HTTP" });
    Annotations.fromStack(stack).hasWarning("/Binder", Match.stringLikeRegexp("plain HTTP"));
    for (const name of ["Url", "BucketName", "ClusterName", "ServiceName", "CreateTokenCommand"]) template.hasOutput(name, {});
    const cmd = JSON.stringify(template.findOutputs("CreateTokenCommand"));
    expect(cmd).toContain("aws ecs execute-command");
    expect(cmd).toContain("binder token create --name you");
  });

  test("log group keeps logs for a month", () => {
    template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 30 });
  });
});

describe("with a domain", () => {
  const { template } = synth(DOMAIN);

  test("HTTPS listener with a DNS-validated certificate, HTTP redirects, and an alias", () => {
    template.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: "binder.example.com",
      ValidationMethod: "DNS",
      DomainValidationOptions: [{ DomainName: "binder.example.com", HostedZoneId: "Z0123456789EXAMPLE" }],
    });
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", { Port: 443, Protocol: "HTTPS" });
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 80,
      DefaultActions: [Match.objectLike({ Type: "redirect", RedirectConfig: Match.objectLike({ Protocol: "HTTPS", Port: "443" }) })],
    });
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      Name: "binder.example.com.",
      Type: "A",
      HostedZoneId: "Z0123456789EXAMPLE",
      AliasTarget: Match.anyValue(),
    });
    expect(envOf(template).BINDER_PUBLIC_URL).toBe("https://binder.example.com");
  });

  test("internet-facing is allowed once HTTPS and auth are on", () => {
    const { template: t } = synth({ ...DOMAIN, internetFacing: "true" });
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", { Scheme: "internet-facing" });
  });
});

describe("OIDC", () => {
  const { template } = synth(OIDC);

  test("settings are env, the client secret is an ECS secret from the given ARN", () => {
    expect(envOf(template)).toMatchObject({
      BINDER_AUTH: "oidc",
      BINDER_OIDC_ISSUER: "https://sso.example.com/realms/team",
      BINDER_OIDC_CLIENT_ID: "binder",
      BINDER_OIDC_LABEL: "Keycloak",
      BINDER_ALLOWED_GROUPS: "binder-users",
      BINDER_OIDC_GROUPS_CLAIM: "groups",
      BINDER_PUBLIC_URL: "https://binder.example.com",
    });
    expect(envOf(template)).not.toHaveProperty("BINDER_OIDC_CLIENT_SECRET");
    expect(secretNames(template)).toEqual(["BINDER_OIDC_CLIENT_SECRET", "BINDER_SECRET_KEY"]);
    const secret = container(template).Secrets.find((s: { Name: string }) => s.Name === "BINDER_OIDC_CLIENT_SECRET");
    expect(secret.ValueFrom).toBe(OIDC_SECRET);
  });

  test("only the execution role can read the client secret", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyName: Match.stringLikeRegexp("ExecutionRole"),
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: Match.arrayWith(["secretsmanager:GetSecretValue"]), Resource: Match.arrayWith([OIDC_SECRET]) }),
        ]),
      },
    });
  });
});

describe("full image", () => {
  test("uses the -full tag and more memory for Chromium", () => {
    const { template } = synth({ previews: "full" });
    expect(container(template).Image).toBe("ghcr.io/pb3975/binder:9.9.9-full");
    template.hasResourceProperties("AWS::ECS::TaskDefinition", { Cpu: "512", Memory: "1024" });
  });
});

describe("existing VPC", () => {
  test("no new VPC or endpoint; tasks in the private subnets without a public IP", () => {
    const { template } = synth({ vpcId: VPC_ID, subnetType: "private" });
    template.resourceCountIs("AWS::EC2::VPC", 0);
    template.resourceCountIs("AWS::EC2::VPCEndpoint", 0);
    const privateSubnets = [subnet(3, "us-east-1a").subnetId, subnet(4, "us-east-1b").subnetId];
    template.hasResourceProperties("AWS::ECS::Service", {
      NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: "DISABLED", Subnets: privateSubnets } },
    });
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", { Scheme: "internal", Subnets: privateSubnets });
  });
});

describe("kept bucket", () => {
  test("bucketName reuses a bucket instead of creating one, and the grant follows it", () => {
    const { template } = synth({ bucketName: "binder-data-example" });
    template.resourceCountIs("AWS::S3::Bucket", 0);
    expect(JSON.stringify(envOf(template).BINDER_STORAGE)).toContain("s3://binder-data-example/binder");
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["s3:PutObject"]),
            Resource: ["arn:aws:s3:::binder-data-example", "arn:aws:s3:::binder-data-example/binder/*"],
          }),
        ]),
      },
    });
  });
});

describe("refuses unsafe combinations at synth", () => {
  const refuses = (ctx: Context, message: RegExp) => expect(() => synth(ctx)).toThrow(message);

  test("internet-facing with auth=none", () => refuses({ ...DOMAIN, internetFacing: "true", auth: "none" }, /auth=none/));
  test("internet-facing without HTTPS", () => refuses({ internetFacing: "true" }, /without HTTPS/));
  test("OIDC without an HTTPS domain", () => {
    const { domainName: _d, hostedZoneId: _z, ...noDomain } = OIDC;
    refuses(noDomain, /auth=oidc needs HTTPS/);
  });
  test("OIDC client secret given as a value instead of an ARN", () =>
    refuses({ ...OIDC, oidcClientSecretArn: "hunter2" }, /full ARN/));
  test("OIDC with no allowlist", () => refuses({ ...OIDC, allowedGroups: undefined }, /allowedUsers or allowedGroups/));
  test("header mode, which an ALB cannot make safe", () => refuses({ auth: "header" }, /auth=header/));
});

// The stack and Binder are built separately, so check that Binder's own config parser accepts the
// environment the stack gives the container. CloudFormation fills some values at deploy time; the
// test puts synthetic values in their place, and adds what the image and the secrets provide.
describe("the container's environment starts Binder", () => {
  const atDeploy: Record<string, string> = {
    BINDER_STORAGE: "s3://binder-data-example/binder",
    BINDER_PUBLIC_URL: "http://internal-binder-123.us-east-1.elb.amazonaws.com",
    AWS_REGION: "us-east-1",
  };
  const fromSecrets: Record<string, string> = {
    BINDER_SECRET_KEY: "A".repeat(64), // the generated secret: 64 alphanumeric characters
    BINDER_OIDC_CLIENT_SECRET: "synthetic-client-secret",
  };
  const IMAGE_ENV = { BINDER_LITESTREAM_SOCKET: "/tmp/litestream.sock" }; // from the Dockerfile

  const startEnv = (t: Template) => {
    const env: Record<string, string> = { ...IMAGE_ENV };
    const pick = (k: string, from: Record<string, string>) => from[k] ?? expect.unreachable(`no synthetic value for ${k}`);
    for (const [k, v] of Object.entries(envOf(t))) env[k] = typeof v === "string" ? v : pick(k, atDeploy);
    for (const k of secretNames(t)) env[k] = pick(k, fromSecrets);
    return env;
  };

  const cases: [string, Context, string][] = [
    ["token, internal, plain HTTP", {}, "token"],
    ["none, internal", { auth: "none" }, "none"],
    ["token with HTTPS", DOMAIN, "token"],
    ["oidc", OIDC, "oidc"],
  ];
  for (const [name, ctx, mode] of cases)
    test(name, () => {
      const cfg = loadConfig(startEnv(synth(ctx).template));
      expect(cfg.auth.mode).toBe(mode as never);
      expect(cfg.storage).toMatchObject({ kind: "s3", bucket: "binder-data-example", prefix: "binder", region: "us-east-1" });
      expect(cfg.secretKey).not.toBeNull();
    });
});
