// One Binder task on ECS Fargate (arm64) behind an Application Load Balancer, with S3 as the
// durable store. Fargate has no persistent disk, so the container keeps SQLite on its task
// storage and Litestream replicates it to S3. Binder runs one writer only: never two tasks.
import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { imageRef, type BinderConfig } from "./config.ts";

const PORT = 8480;
const CONTAINER = "binder";

export interface BinderStackProps extends cdk.StackProps {
  config: BinderConfig;
}

export class BinderStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BinderStackProps) {
    super(scope, id, props);
    const { config } = props;
    const https = config.domain !== undefined;

    // Network. A new VPC has public subnets only: no NAT gateway (about 32 USD a month each).
    // The task gets a public IP to pull its image and reach an OIDC issuer; S3 traffic stays on
    // the gateway endpoint. Nothing reaches the task except the load balancer.
    const vpc = config.vpcId
      ? ec2.Vpc.fromLookup(this, "Vpc", { vpcId: config.vpcId })
      : new ec2.Vpc(this, "Vpc", {
          maxAzs: 2,
          natGateways: 0,
          subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
          gatewayEndpoints: { S3: { service: ec2.GatewayVpcEndpointAwsService.S3 } },
        });
    const subnets: ec2.SubnetSelection = {
      subnetType: config.subnetType === "public" ? ec2.SubnetType.PUBLIC : ec2.SubnetType.PRIVATE_WITH_EGRESS,
    };

    // Storage. Binder never hard-deletes, so the bucket outlives the stack, and a new stack can
    // take it back with bucketName.
    const bucket = config.bucketName
      ? s3.Bucket.fromBucketName(this, "Data", config.bucketName)
      : new s3.Bucket(this, "Data", {
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          enforceSSL: true,
          encryption: s3.BucketEncryption.S3_MANAGED,
          versioned: true,
          lifecycleRules: [{ noncurrentVersionExpiration: cdk.Duration.days(30), abortIncompleteMultipartUploadAfter: cdk.Duration.days(7) }],
          removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

    // Signs content URLs and sessions. 64 alphanumeric characters decode as base64 to 48 bytes.
    // Kept on destroy with the bucket it belongs to.
    const secretKey = new secretsmanager.Secret(this, "SecretKey", {
      description: "BINDER_SECRET_KEY for Binder",
      generateSecretString: { passwordLength: 64, excludePunctuation: true, includeSpace: false },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Load balancer. Internal by default: the team reaches it over a VPN, peering, or Direct Connect.
    const albSg = new ec2.SecurityGroup(this, "LoadBalancerSecurityGroup", {
      vpc,
      description: "Binder load balancer",
      allowAllOutbound: false,
    });
    const alb = new elbv2.ApplicationLoadBalancer(this, "LoadBalancer", {
      vpc,
      internetFacing: config.internetFacing,
      vpcSubnets: config.internetFacing ? { subnetType: ec2.SubnetType.PUBLIC } : subnets,
      securityGroup: albSg,
      // 64 MB uploads from a slow link need more than the default 60 seconds.
      idleTimeout: cdk.Duration.minutes(5),
      dropInvalidHeaderFields: true,
    });
    const source = ec2.Peer.ipv4(config.allowedCidr);
    albSg.addIngressRule(source, ec2.Port.tcp(80), "HTTP");
    if (https) albSg.addIngressRule(source, ec2.Port.tcp(443), "HTTPS");

    const publicUrl = https ? `https://${config.domain!.name}` : `http://${alb.loadBalancerDnsName}`;

    // Service.
    const cluster = new ecs.Cluster(this, "Cluster", { vpc });
    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const taskDefinition = new ecs.FargateTaskDefinition(this, "Task", {
      cpu: config.cpu,
      memoryLimitMiB: config.memory,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    bucket.grantReadWrite(taskDefinition.taskRole, `${config.storagePrefix}/*`);

    const environment: Record<string, string> = {
      BINDER_STORAGE: `s3://${bucket.bucketName}/${config.storagePrefix}`,
      AWS_REGION: this.region,
      BINDER_PUBLIC_URL: publicUrl,
      BINDER_AUTH: config.auth.mode,
    };
    const secrets: Record<string, ecs.Secret> = { BINDER_SECRET_KEY: ecs.Secret.fromSecretsManager(secretKey) };
    if (config.auth.mode === "oidc") {
      const a = config.auth;
      const optional = {
        BINDER_OIDC_SCOPES: a.scopes,
        BINDER_OIDC_LABEL: a.label,
        BINDER_ALLOWED_USERS: a.allowedUsers,
        BINDER_ALLOWED_GROUPS: a.allowedGroups,
        BINDER_OIDC_GROUPS_CLAIM: a.groupsClaim,
      };
      Object.assign(environment, { BINDER_OIDC_ISSUER: a.issuer, BINDER_OIDC_CLIENT_ID: a.clientId });
      for (const [k, v] of Object.entries(optional)) if (v) environment[k] = v;
      const clientSecret = secretsmanager.Secret.fromSecretCompleteArn(this, "OidcClientSecret", a.clientSecretArn);
      secrets.BINDER_OIDC_CLIENT_SECRET = ecs.Secret.fromSecretsManager(clientSecret);
    }

    // An image in a private ECR repository of this account (a mirror) needs pull rights for the
    // execution role; any other registry must allow anonymous pulls.
    const ecrRepo = config.image.match(/^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/(.+)$/);
    const image = ecrRepo
      ? ecs.ContainerImage.fromEcrRepository(
          ecr.Repository.fromRepositoryAttributes(this, "ImageRepository", {
            repositoryName: ecrRepo[3]!,
            repositoryArn: `arn:${this.partition}:ecr:${ecrRepo[2]}:${ecrRepo[1]}:repository/${ecrRepo[3]}`,
          }),
          imageRef(config).slice(config.image.length + 1),
        )
      : ecs.ContainerImage.fromRegistry(imageRef(config));
    taskDefinition.addContainer(CONTAINER, {
      image,
      portMappings: [{ containerPort: PORT }],
      environment,
      secrets,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "binder" }),
      // Litestream copies the last writes to S3 on SIGTERM.
      stopTimeout: cdk.Duration.seconds(30),
    });

    const taskSg = new ec2.SecurityGroup(this, "TaskSecurityGroup", { vpc, description: "Binder task" });
    taskSg.addIngressRule(albSg, ec2.Port.tcp(PORT), "From the load balancer only");
    albSg.addEgressRule(taskSg, ec2.Port.tcp(PORT), "To the Binder task");

    // One writer: never two tasks, even during a deploy. ECS stops the old task before it starts
    // the new one (a short outage), and rolls back if the new one never turns healthy.
    const service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition,
      desiredCount: 1,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { enable: true, rollback: true },
      availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.DISABLED,
      assignPublicIp: config.subnetType === "public",
      vpcSubnets: subnets,
      securityGroups: [taskSg],
      enableExecuteCommand: true,
      // Restoring the database from S3 at start can take a while on a large library.
      healthCheckGracePeriod: cdk.Duration.minutes(2),
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, "Targets", {
      vpc,
      port: PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: { path: "/healthz", healthyHttpCodes: "200", interval: cdk.Duration.seconds(15), healthyThresholdCount: 2 },
      deregistrationDelay: cdk.Duration.seconds(10),
    });

    if (https) {
      const domain = config.domain!;
      const zone = route53.HostedZone.fromHostedZoneId(this, "Zone", domain.hostedZoneId);
      const certificate = new acm.Certificate(this, "Certificate", {
        domainName: domain.name,
        validation: acm.CertificateValidation.fromDns(zone),
      });
      alb.addListener("Https", {
        port: 443,
        certificates: [certificate],
        sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
        open: false,
        defaultTargetGroups: [targetGroup],
      });
      alb.addRedirect({ sourcePort: 80, targetPort: 443, open: false });
      // A trailing dot makes the name absolute, so the zone's name is not needed.
      new route53.ARecord(this, "Alias", {
        zone,
        recordName: `${domain.name}.`,
        target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(alb)),
      });
    } else {
      alb.addListener("Http", { port: 80, open: false, defaultTargetGroups: [targetGroup] });
      cdk.Annotations.of(this).addWarning(
        "Binder is served over plain HTTP: tokens and session cookies cross the network unencrypted. " +
          "Set domainName and hostedZoneId to get HTTPS.",
      );
    }
    if (config.auth.mode === "none")
      cdk.Annotations.of(this).addWarning("auth=none: anyone who can reach the load balancer can publish and remove artifacts.");

    const findTask = `"$(aws ecs list-tasks --region ${this.region} --cluster ${cluster.clusterName} --service-name ${service.serviceName} --query 'taskArns[0]' --output text)"`;
    new cdk.CfnOutput(this, "Url", { value: publicUrl, description: "Open Binder here" });
    new cdk.CfnOutput(this, "BucketName", { value: bucket.bucketName });
    new cdk.CfnOutput(this, "ClusterName", { value: cluster.clusterName });
    new cdk.CfnOutput(this, "ServiceName", { value: service.serviceName });
    new cdk.CfnOutput(this, "CreateTokenCommand", {
      description: "Creates a Binder token with ECS Exec (needs the Session Manager plugin)",
      value:
        `aws ecs execute-command --region ${this.region} --cluster ${cluster.clusterName} --task ${findTask} ` +
        `--container ${CONTAINER} --interactive --command "binder token create --name you"`,
    });
  }
}
