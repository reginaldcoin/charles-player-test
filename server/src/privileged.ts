// Privileged (host-side) functions for the Charles Hamilton Player.
//
// Password verification hashes are the one piece of this artifact that
// needs a host capability: Argon2id. Action code runs in a portable
// sandbox that must never touch a fast hash or a host global, so the
// slow-KDF work lives here behind a typed contract. OWASP's password
// storage guidance is the bar: Argon2id first; a salted scrypt with
// strong parameters is the fallback if the host ever lacks it. Plain
// SHA-256 of a password is never used anywhere in this artifact.

import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export const Privileged = definePrivilegedContracts({
  hashPassword: {
    request: z.object({ password: z.string().min(1).max(200) }),
    response: z.object({ hash: z.string(), algo: z.string() }),
  },
  verifyPassword: {
    request: z.object({
      password: z.string().min(1).max(200),
      stored: z.string().min(1),
      algo: z.string().min(1),
    }),
    response: z.object({ ok: z.boolean() }),
  },
});

interface BunPasswordApi {
  hash: (
    password: string,
    opts: { algorithm: "argon2id" },
  ) => Promise<string>;
  verify: (password: string, hash: string) => Promise<boolean>;
}

function bunPassword(): BunPasswordApi | null {
  const g = globalThis as unknown as { Bun?: { password?: BunPasswordApi } };
  return g.Bun?.password ?? null;
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  params: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, params, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export const handlers = definePrivilegedHandlers(Privileged, {
  async hashPassword(args) {
    const bp = bunPassword();
    if (bp) {
      return {
        hash: await bp.hash(args.password, { algorithm: "argon2id" }),
        algo: "argon2id",
      };
    }
    const salt = randomBytes(16);
    const params = { N: 32768, r: 8, p: 1 };
    const key = await scryptAsync(args.password, salt, 32, params);
    return {
      hash: [
        "scrypt",
        params.N,
        params.r,
        params.p,
        salt.toString("base64"),
        key.toString("base64"),
      ].join("$"),
      algo: "scrypt",
    };
  },

  async verifyPassword(args) {
    if (args.algo === "argon2id") {
      const bp = bunPassword();
      if (!bp) return { ok: false };
      return { ok: await bp.verify(args.password, args.stored) };
    }
    const parts = args.stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return { ok: false };
    const params = {
      N: Number(parts[1]),
      r: Number(parts[2]),
      p: Number(parts[3]),
    };
    const salt = Buffer.from(parts[4] ?? "", "base64");
    const expected = Buffer.from(parts[5] ?? "", "base64");
    if (expected.length === 0) return { ok: false };
    const key = await scryptAsync(args.password, salt, expected.length, params);
    return { ok: timingSafeEqual(key, expected) };
  },
});
