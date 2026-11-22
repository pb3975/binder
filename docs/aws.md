# Binder on AWS (ECS Fargate and S3)

This quick start takes a team from an empty AWS account to a private Binder. One AWS CDK stack in [`deploy/aws/`](../deploy/aws/) creates everything.

**Deployed in CI: no.** CI checks the stack with unit tests, `cdk synth`, and `cfn-lint`, but it has not yet deployed it to a real account. Please report anything that needs changing.

**Needs Binder 0.2.0, which is not released yet.** S3 storage, `auth=oidc`, and `auth=none` arrive in 0.2.0, so this guide has no working path until that release is out. The stack refuses any image tag older than 0.2.0 at synth.

## What you get

- One Binder task on ECS Fargate (arm64, Graviton). The task has no persistent disk. Binder keeps its SQLite database on the task's own storage, and Litestream copies every change to S3. At start, the container restores the database from S3.
- An S3 bucket that holds every artifact version and the database copy. It is private, encrypted, versioned, and kept when you delete the stack.
- An Application Load Balancer (ALB). It is **internal** by default: it has only private addresses, so your team reaches it over a VPN, VPC peering, Transit Gateway, or Direct Connect.
- A new VPC with two public subnets and no NAT gateway. The task gets a public IP only to pull its image and to reach an OIDC provider. Its security group accepts traffic only from the load balancer. S3 traffic goes through a free gateway endpoint.
- HTTPS when you give a domain: an ACM certificate (validated in DNS), an HTTPS listener, a redirect from HTTP, and a Route 53 alias.
- `BINDER_SECRET_KEY`, generated in Secrets Manager and given to the task as an ECS secret.
- ECS Exec, so you can run `binder token create` inside the task.
- Logs in CloudWatch, kept for 30 days.

Binder supports one writer only. The service never runs two tasks, even during a deploy: ECS stops the old task before it starts the new one.

## Prerequisites

1. An AWS account, and credentials for it in your shell (for example `aws configure sso`, then `export AWS_PROFILE=<profile>`). The account needs permission to create the resources above.
2. [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html).
3. The [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) for the AWS CLI. ECS Exec needs it.
4. [Bun](https://bun.sh) 1.4 (runs the CDK app and its tests) and [Node.js](https://nodejs.org) 22 (runs the CDK CLI).
5. For HTTPS: a domain name in a **public** Route 53 hosted zone, and that zone's ID. ACM validates the certificate through public DNS.

## Deploy with tokens (the default)

1. After the 0.2.0 release, get the code at a release tag, and install the CDK:

   ```sh
   git clone https://github.com/pb3975/binder && cd binder
   git checkout v0.2.0                 # or a later release; the tag exists once 0.2.0 is out
   cd deploy/aws
   bun install --frozen-lockfile
   ```

   The image tag defaults to the version in the repository's `package.json`, so the checkout decides which Binder you run.

2. Prepare the account and region once. This creates the `CDKToolkit` stack that CDK deploys through:

   ```sh
   bun run cdk bootstrap
   ```

3. Deploy:

   ```sh
   bun run cdk deploy
   ```

   Without a domain, Binder serves plain HTTP and CDK prints a warning. Tokens and session cookies then cross your private network unencrypted. Add a domain to get HTTPS:

   ```sh
   bun run cdk deploy -c domainName=binder.example.com -c hostedZoneId=Z0123456789EXAMPLE
   ```

4. Note the outputs. `Url` is where Binder is. `CreateTokenCommand` makes the first token.

Pass the same `-c` values on every deploy. A value that you leave out goes back to its default. Keep your deploy command in a small script.

## Create the first token

Run the `CreateTokenCommand` output. It has this form:

```sh
aws ecs execute-command --region us-east-1 --cluster <cluster> \
  --task "$(aws ecs list-tasks --region us-east-1 --cluster <cluster> --service-name <service> --query 'taskArns[0]' --output text)" \
  --container binder --interactive --command "binder token create --name you"
```

1. Copy the `bnd_...` token that it prints. Binder shows it only once.
2. Open the `Url` output and paste the token.
3. Make one token per person and per agent. Change `--name you` in the command.

ECS Exec needs about a minute after a task starts. If the command fails with `TargetNotConnectedException`, wait and try again.

## Reach an internal load balancer

The internal ALB has private addresses in the VPC (`10.0.0.0/16`). Its DNS name resolves from anywhere, but only networks routed into the VPC can connect:

- **AWS Client VPN** or **Site-to-Site VPN** into the VPC.
- **VPC peering** or **Transit Gateway** from a VPC your team already reaches.
- **Direct Connect**.

If your network already uses `10.0.0.0/16`, or you already have a VPC with a VPN, deploy into it with `-c vpcId=vpc-...`. The stack then uses its public subnets. Use `-c subnetType=private` when that VPC has private subnets with a NAT gateway. The stack adds no S3 endpoint to an existing VPC.

`-c allowedCidr=10.20.0.0/16` limits the load balancer to your VPN's address range. The default is any address, which an internal ALB can still only receive from routed networks.

`-c internetFacing=true` puts the ALB on the internet. The stack refuses it without HTTPS, and refuses it with `auth=none`.

## Deploy with OIDC (Keycloak example)

With OIDC, people sign in with your identity provider. Agents still use tokens. OIDC needs HTTPS, so it needs a domain.

1. In Keycloak, create a client for Binder:
   - Client type `OpenID Connect`, client ID `binder`, client authentication on.
   - Valid redirect URIs: `https://binder.example.com/*`.
   - To allow by group, add a `Group Membership` mapper to the client's dedicated scope, with token claim name `groups` and "Full group path" off.
2. Store the client secret in Secrets Manager, in the same region as Binder. Copy the `ARN` it prints:

   ```sh
   aws secretsmanager create-secret --name binder/oidc-client-secret --secret-string '<client secret from Keycloak>'
   ```

3. Deploy:

   ```sh
   bun run cdk deploy \
     -c domainName=binder.example.com -c hostedZoneId=Z0123456789EXAMPLE \
     -c auth=oidc \
     -c oidcIssuer=https://sso.example.com/realms/team \
     -c oidcClientId=binder \
     -c oidcClientSecretArn=arn:aws:secretsmanager:us-east-1:123456789012:secret:binder/oidc-client-secret-AbCdEf \
     -c allowedGroups=binder-users -c oidcGroupsClaim=groups \
     -c oidcLabel=Keycloak
   ```

The stack gives the client secret to the task as an ECS secret. It never puts the value in the template. The task reaches the issuer through its public IP, so the issuer must be reachable from the internet, or from the VPC when you use an existing VPC.

The stack refuses OIDC without `allowedUsers` or `allowedGroups`, so a public issuer cannot let in everyone. Use `allowedUsers=*` if you really want everyone the issuer accepts.

## All inputs

Pass each one as `-c key=value`.

| Key | Default | What it does |
|---|---|---|
| `image` | `ghcr.io/pb3975/binder` | Image repository. A private ECR repository in this account (`<account>.dkr.ecr.<region>.amazonaws.com/<name>`, such as a mirror) works: the stack lets the task pull from it. Any other registry must allow anonymous pulls. |
| `imageTag` | the version in `package.json` | Binder release to run. Synth refuses a release older than 0.2.0, because it has no S3 storage and Fargate would delete its data. |
| `previews` | `slim` | `full` runs the `-full` image with Chromium previews. Read [why it is opt-in](design.md#previews). |
| `auth` | `token` | `token`, `oidc`, or `none` (internal only, with a warning). `header` is refused: an ALB alone cannot make a user header safe. |
| `oidcIssuer`, `oidcClientId`, `oidcClientSecretArn` | | Required for `auth=oidc`. The secret is an ARN, never a value. |
| `oidcScopes`, `oidcLabel`, `oidcGroupsClaim` | | Optional OIDC settings. |
| `allowedUsers`, `allowedGroups` | | Who may sign in with OIDC. At least one is required. |
| `domainName`, `hostedZoneId` | | Turn on HTTPS. Set both. |
| `internetFacing` | `false` | `true` makes the ALB public. Needs HTTPS and real auth. |
| `allowedCidr` | `0.0.0.0/0` | Source addresses the ALB accepts. |
| `cpu`, `memory` | `256`, `512` (`512`, `1024` for `full`) | Fargate task size. |
| `vpcId` | | Use this VPC instead of a new one. |
| `subnetType` | `public` | `private` puts the task and an internal ALB in an existing VPC's private subnets. |
| `storagePrefix` | `binder` | Key prefix in the bucket. |
| `bucketName` | | Reuse a bucket from a deleted stack instead of creating one. |

## Rough monthly cost

These are estimates for `us-east-1` with light use. Check the AWS pricing pages for your region.

| Item | About |
|---|---|
| Application Load Balancer | 16 to 20 USD |
| Fargate arm64, 0.25 vCPU and 0.5 GB, always on | 7 to 10 USD |
| S3 storage and requests | a few cents |
| Secrets Manager (one or two secrets) | 0.40 to 0.80 USD |
| CloudWatch Logs | a few cents |

There is no NAT gateway, which saves about 32 USD a month. The task's public IPv4 address costs about 3.60 USD a month.

## Backups

The bucket holds everything: artifact files and the Litestream copy of the database under `<prefix>/db`. Litestream copies database changes to S3 about once a second. If the task stops suddenly, you can lose about the last second of writes. On a normal stop, the task has 30 seconds to copy its last writes.

**S3 versioning is the first safety net.** For 30 days, an overwritten or deleted object keeps its old version in the bucket. You can recover from a bad write or a deletion without a separate copy.

**To keep a copy outside the bucket, stop Binder first.** Do not copy the bucket while Binder runs. Litestream compacts and deletes its own files while it works, so a live copy can miss files that a restore needs.

1. Stop the task, and wait until it has stopped. The stop makes Litestream copy its last writes:

   ```sh
   aws ecs update-service --cluster <cluster> --service <service> --desired-count 0
   aws ecs wait services-stable --cluster <cluster> --services <service>
   ```

2. Copy the prefix:

   ```sh
   aws s3 sync s3://<bucket>/binder ./binder-backup/binder
   ```

3. Start Binder again. Do not count on `cdk deploy` for this: it changes only what changed in the template.

   ```sh
   aws ecs update-service --cluster <cluster> --service <service> --desired-count 1
   ```

4. Check that the copy restores. Upload it to an empty scratch bucket. Then start Binder on that bucket, for example with this stack in another account or region and `-c bucketName=<scratch bucket>`. Open it, and check that your newest artifacts are there. A copy that you have never restored is not yet a backup.

Binder is down from step 1 to step 3, usually a few minutes. The cluster and service names are in the stack outputs.

## Upgrades

1. Read [CHANGELOG.md](../CHANGELOG.md) for the new version. Binder upgrades its database schema on start, and an older Binder cannot read a newer schema.
2. Deploy with the new tag, or check out the new release:

   ```sh
   bun run cdk deploy -c imageTag=0.3.0      # plus your usual -c values
   ```

ECS stops the one task and starts the new one, so Binder is down for a minute or two. If the new task never turns healthy, ECS rolls back to the previous task definition.

## Teardown

```sh
bun run cdk destroy
```

This deletes the service, the load balancer, the VPC, the cluster, and the logs. It **keeps** these on purpose:

- **The S3 bucket**, with all artifacts. Binder never hard-deletes data. To use it again, deploy with `-c bucketName=<bucket>`.
- **The `BINDER_SECRET_KEY` secret.** A new stack makes a new key, so content links signed with the old key stop working.
- **The OIDC client secret** that you created.
- **The `CDKToolkit` bootstrap stack**, which other CDK apps in the account may use.

To remove them on purpose:

1. Empty the bucket in the S3 console (**Empty** removes every version), then delete it: `aws s3 rb s3://<bucket>`.
2. Delete the secrets: `aws secretsmanager delete-secret --secret-id <arn>`. Secrets Manager keeps a deleted secret for 7 to 30 days before it is gone.
3. Only if no other CDK app uses the account and region: empty the `cdk-...-assets-...` bucket, then `aws cloudformation delete-stack --stack-name CDKToolkit`.

## Develop the stack

```sh
cd deploy/aws
bun install --frozen-lockfile
bun run check          # types and CDK assertion tests (bun test)
bun run synth-check    # cdk synth for two configurations, then cfn-lint (needs cfn-lint 1.60.1)
```

Neither needs AWS credentials. CI runs both in the `aws` job.
