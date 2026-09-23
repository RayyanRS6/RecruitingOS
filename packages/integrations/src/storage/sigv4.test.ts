import { describe, expect, it } from "vitest";
import { awsEncode, presignUrl, signRequest } from "./sigv4";

/** The worked examples from the S3 developer documentation ("Authenticating Requests", signature version 4). */
const creds = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" };
const now = new Date("2013-05-24T00:00:00Z");

describe("SigV4 presigned URL", () => {
  it("matches the documented GET example (examplebucket/test.txt, 86400 seconds)", () => {
    const url = presignUrl(creds, { method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", expiresSeconds: 86400, now });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });
  it("encodes object keys segment by segment and keeps extra query parameters in the signature", () => {
    const url = presignUrl(creds, { method: "GET", url: "https://h.example.com/storage/v1/s3/bucket/t%20enant/a+b%3Fc.pdf?response-content-disposition=attachment%3B%20filename%3D%22r%C3%A9sum%C3%A9.pdf%22", expiresSeconds: 120, now });
    const u = new URL(url);
    expect(u.pathname).toBe("/storage/v1/s3/bucket/t%20enant/a%2Bb%3Fc.pdf");
    expect(u.searchParams.get("response-content-disposition")).toBe('attachment; filename="résumé.pdf"');
    expect(u.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("caps the lifetime at seven days and never below one second", () => {
    expect(new URL(presignUrl(creds, { method: "PUT", url: "https://h.example.com/b/k", expiresSeconds: 10_000_000, now })).searchParams.get("X-Amz-Expires")).toBe("604800");
    expect(new URL(presignUrl(creds, { method: "PUT", url: "https://h.example.com/b/k", expiresSeconds: 0, now })).searchParams.get("X-Amz-Expires")).toBe("1");
  });
});

describe("SigV4 signed request", () => {
  it("matches the documented GET Object example (Range header, empty payload hash)", () => {
    const headers = signRequest(creds, {
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      headers: { Range: "bytes=0-9" },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      now,
    });
    expect(headers.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
    expect(headers.host).toBeUndefined();
  });
  it("matches the documented PUT Object example (payload hash of 'Welcome to Amazon S3.')", () => {
    const headers = signRequest(creds, {
      method: "PUT",
      url: "https://examplebucket.s3.amazonaws.com/test$file.text",
      headers: { Date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
      payloadHash: "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
      now,
    });
    expect(headers.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });
  it("matches the documented GET Bucket (list objects) example with query parameters", () => {
    const headers = signRequest(creds, {
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J",
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      now,
    });
    expect(headers.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    );
  });
});

describe("awsEncode", () => {
  it("encodes everything but unreserved characters, uppercase hex, slash optional", () => {
    expect(awsEncode("a b+c/d~e.f-g_h")).toBe("a%20b%2Bc%2Fd~e.f-g_h");
    expect(awsEncode("a/b", true)).toBe("a/b");
    expect(awsEncode("é")).toBe("%C3%A9");
  });
});
