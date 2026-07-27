import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sqlRoot, SqlRootError } from "../src/backup/http.ts";
import type { AppConfig } from "../src/config.ts";

const cfg = {
  surrealUrl: "ws://127.0.0.1:1/rpc",
  surrealUser: "root",
  surrealPass: "SuperPrivatePassword",
} as AppConfig;

async function sqlRootFailure(operation: Promise<void>): Promise<SqlRootError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(SqlRootError);
    return error as SqlRootError;
  }
  throw new Error("expected sqlRoot to fail");
}

describe("bounded authenticated root SQL", () => {
  test("times out a hanging namespace removal without leaking credentials or SQL", async () => {
    let redirect: RequestRedirect | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      redirect = init?.redirect;
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("missing timeout signal"));
        signal.addEventListener("abort", () => reject(new Error(
          "SuperPrivatePassword REMOVE NAMESPACE private_target",
        )), { once: true });
      });
    });

    const error = await sqlRootFailure(sqlRoot(
      cfg,
      "REMOVE NAMESPACE IF EXISTS baka_restore_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;",
      { timeoutMs: 5, fetchImpl },
    ));

    expect(redirect).toBe("error");
    expect(error.evidence).toEqual({ category: "timeout" });
    expect(error.message).not.toContain("SuperPrivatePassword");
    expect(error.message).not.toContain("REMOVE NAMESPACE");
    expect(JSON.stringify(error.evidence)).not.toContain("private_target");
  });

  test("reports SQL failures using bounded hash evidence only", async () => {
    const privateBody = JSON.stringify([{
      status: "ERR",
      detail: "SuperPrivateToken internal database response",
    }]);
    const error = await sqlRootFailure(sqlRoot(cfg, "REMOVE NAMESPACE IF EXISTS safe;", {
      fetchImpl: (async () => new Response(privateBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })),
    }));

    expect(error.evidence).toEqual({
      category: "sql_error",
      httpStatus: 200,
      responseBytes: Buffer.byteLength(privateBody),
      responseSha256: createHash("sha256").update(privateBody).digest("hex"),
      responseTruncated: false,
    });
    expect(error.message).not.toContain("SuperPrivateToken");
    expect(JSON.stringify(error.evidence)).not.toContain("internal database response");
  });

  test("rejects a declared body over one MiB before reading it", async () => {
    const response = new Response("SuperPrivateToken", {
      status: 500,
      headers: { "Content-Length": String(1024 * 1024 + 1) },
    });
    const error = await sqlRootFailure(sqlRoot(cfg, "REMOVE NAMESPACE IF EXISTS safe;", {
      fetchImpl: async () => response,
    }));

    expect(error.evidence).toEqual({
      category: "response_too_large",
      httpStatus: 500,
      responseBytes: 1024 * 1024 + 1,
      responseTruncated: true,
    });
    expect(error.message).not.toContain("SuperPrivateToken");
  });
});
