import { describe, expect, test } from "bun:test";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compressFile, type Compression } from "../src/backup/compress.ts";
import {
  reorderAuthenticatedCompressedImportFile,
  reorderCompressedImportFile,
} from "../src/backup/reorder-import.ts";
import { authenticateRegularFileIdentity } from "../src/backup/safety.ts";
import { hashFile } from "../src/sources/snapshot/hashing.ts";

const SEARCH_INDEX = `DEFINE INDEX IF NOT EXISTS search_document_content
ON TABLE search_document
FIELDS content
FULLTEXT ANALYZER archive_mixed
BM25(1.2,0.75) HIGHLIGHTS;`;

const CHUNK_INDEX = `DEFINE INDEX IF NOT EXISTS chunk_content
ON TABLE chunk
FIELDS content
FULLTEXT ANALYZER archive_mixed
BM25(1.2,0.75) HIGHLIGHTS;`;

const PREFIX = `OPTION IMPORT;
DEFINE TABLE IF NOT EXISTS chunk SCHEMAFULL;
DEFINE TABLE IF NOT EXISTS search_document SCHEMAFULL;
`;

const DATA = `
-- TABLE DATA: chunk
INSERT [{ id: chunk:one, content: "first; строка" }];
-- TABLE DATA: search_document
INSERT [{ id: search_document:one, content: "second ✅" }];
`;

const VALID_EXPORT = `${PREFIX}${SEARCH_INDEX}\n${CHUNK_INDEX}\n${DATA}`;
const EXPECTED_IMPORT = `${PREFIX}\n\n${DATA}`;

async function withTempDir(operation: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "baka-stream-reorder-"));
  try {
    await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function compressedFixture(
  directory: string,
  kind: Compression,
  content = VALID_EXPORT,
): Promise<string> {
  const plain = path.join(directory, "source.surql");
  const compressed = path.join(directory, `authenticated.surql.${kind === "zstd" ? "zst" : "gz"}`);
  await writeFile(plain, content);
  await compressFile(plain, compressed, kind);
  await rm(plain);
  return compressed;
}

describe("streaming compressed import reorder", () => {
  for (const kind of ["zstd", "gzip"] as const) {
    const binary = kind === "zstd" ? "zstd" : "gzip";
    const unavailable = Bun.which(binary) === null;

    test.skipIf(unavailable)(
      `${kind} writes one fsynced ordered import and preserves the source`, async () => {
        await withTempDir(async (directory) => {
          const source = await compressedFixture(directory, kind);
          const sourceBefore = await hashFile(source);
          const output = path.join(directory, "recovery-import.surql");

          expect(await reorderCompressedImportFile(source, output)).toEqual([SEARCH_INDEX]);

          expect(await readFile(output, "utf8")).toBe(EXPECTED_IMPORT);
          expect((await stat(output)).mode & 0o777).toBe(0o600);
          expect(await hashFile(source)).toEqual(sourceBefore);
          expect((await readdir(directory)).sort()).toEqual([
            path.basename(source),
            "recovery-import.surql",
          ]);
        });
      },
    );

    test.skipIf(unavailable)(
      `${kind} decompressor failures propagate and remove the only output`, async () => {
        await withTempDir(async (directory) => {
          const suffix = kind === "zstd" ? "zst" : "gz";
          const source = path.join(directory, `broken.surql.${suffix}`);
          const output = path.join(directory, "recovery-import.surql");
          await writeFile(source, `not a ${kind} stream`);

          await expect(reorderCompressedImportFile(source, output)).rejects.toThrow(
            new RegExp(`${kind === "zstd" ? "zstd" : "gzip"} завершился`, "u"),
          );

          expect(await readFile(source, "utf8")).toBe(`not a ${kind} stream`);
          await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
          expect(await readdir(directory)).toEqual([path.basename(source)]);
        });
      },
    );
  }

  test("statement validation fails closed and deletes the prepared import", async () => {
    await withTempDir(async (directory) => {
      const source = await compressedFixture(
        directory,
        "gzip",
        VALID_EXPORT.replace("search_document_content", "unexpected_content"),
      );
      const sourceBefore = await hashFile(source);
      const output = path.join(directory, "recovery-import.surql");

      await expect(reorderCompressedImportFile(source, output)).rejects.toThrow(
        "unexpected index identity unexpected_content",
      );

      expect(await hashFile(source)).toEqual(sourceBefore);
      await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(directory)).toEqual([path.basename(source)]);
    });
  });

  test("an existing destination is neither overwritten nor removed", async () => {
    await withTempDir(async (directory) => {
      const source = await compressedFixture(directory, "gzip");
      const output = path.join(directory, "recovery-import.surql");
      await writeFile(output, "owned by another attempt");

      await expect(reorderCompressedImportFile(source, output)).rejects.toMatchObject({
        code: "EEXIST",
      });
      expect(await readFile(output, "utf8")).toBe("owned by another attempt");
    });
  });

  for (const kind of ["zstd", "gzip"] as const) {
    test.skipIf(Bun.which(kind === "zstd" ? "zstd" : "gzip") === null)(
      `${kind} open-fd preparation detects pathname replacement and removes its output`,
      async () => {
        await withTempDir(async (directory) => {
          const source = await compressedFixture(directory, kind);
          const identity = await authenticateRegularFileIdentity(
            source,
            "recovery compressed export",
          );
          const authenticatedInode = `${source}.authenticated-inode`;
          const output = path.join(directory, "recovery-import.surql");

          await expect(reorderAuthenticatedCompressedImportFile(identity, output, {
            afterSourceOpened: async () => {
              await rename(source, authenticatedInode);
              await writeFile(source, await readFile(authenticatedInode), { mode: 0o600 });
            },
          })).rejects.toThrow(/pathname|identity/u);

          expect((await hashFile(authenticatedInode)).sha256).toBe(identity.sha256);
          expect((await hashFile(source)).sha256).toBe(identity.sha256);
          await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
        });
      },
    );
  }

  test("same-inode same-size compressed tamper fails before preparation", async () => {
    await withTempDir(async (directory) => {
      const source = await compressedFixture(directory, "gzip");
      const identity = await authenticateRegularFileIdentity(
        source,
        "recovery compressed export",
      );
      const bytes = await readFile(source);
      bytes[Math.floor(bytes.byteLength / 2)] ^= 0xff;
      await writeFile(source, bytes);
      const output = path.join(directory, "recovery-import.surql");

      await expect(reorderAuthenticatedCompressedImportFile(identity, output))
        .rejects.toThrow("no longer matches its authenticated identity");
      await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
