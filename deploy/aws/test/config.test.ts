// CDK context arrives as strings (`-c internetFacing=false`), so parsing must not trust truthiness.
import { describe, expect, test } from "bun:test";
import { imageRef, parseConfig, type Context } from "../lib/config.ts";

const parse = (ctx: Context) => parseConfig(ctx, { imageTag: "1.2.3" });

describe("parseConfig", () => {
  test("safe defaults", () => {
    expect(parse({})).toEqual({
      image: "ghcr.io/pb3975/binder",
      imageTag: "1.2.3",
      previews: "slim",
      auth: { mode: "token" },
      domain: undefined,
      internetFacing: false,
      allowedCidr: "0.0.0.0/0",
      cpu: 256,
      memory: 512,
      vpcId: undefined,
      subnetType: "public",
      storagePrefix: "binder",
      bucketName: undefined,
    });
    expect(imageRef(parse({}))).toBe("ghcr.io/pb3975/binder:1.2.3");
  });

  test('"false" is false, and anything that is not true or false is refused', () => {
    expect(parse({ internetFacing: "false" }).internetFacing).toBe(false);
    expect(() => parse({ internetFacing: "yes" })).toThrow(/true or false/);
  });

  test("numbers must be whole numbers", () => {
    expect(parse({ cpu: "512", memory: "1024" })).toMatchObject({ cpu: 512, memory: 1024 });
    expect(() => parse({ memory: "1gb" })).toThrow(/whole number/);
  });

  test("enumerations are checked", () => {
    expect(() => parse({ previews: "huge" })).toThrow(/previews must be one of/);
    expect(() => parse({ auth: "basic" })).toThrow(/auth must be one of/);
  });

  test("domainName and hostedZoneId come together", () => {
    expect(() => parse({ domainName: "binder.example.com" })).toThrow(/together/);
    expect(() => parse({ hostedZoneId: "Z0123456789EXAMPLE" })).toThrow(/together/);
    expect(parse({ domainName: "binder.example.com.", hostedZoneId: "Z0123456789EXAMPLE" }).domain).toEqual({
      name: "binder.example.com",
      hostedZoneId: "Z0123456789EXAMPLE",
    });
  });

  test("private subnets need an existing VPC", () => {
    expect(() => parse({ subnetType: "private" })).toThrow(/needs vpcId/);
  });

  test("storage prefix is trimmed of slashes", () => {
    expect(parse({ storagePrefix: "/teams/a/" }).storagePrefix).toBe("teams/a");
  });
});
