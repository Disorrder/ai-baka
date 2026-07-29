import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RecordId, Surreal } from "surrealdb";
import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";
import { selectAll } from "../src/db/repositories/helpers.ts";
import { HARNESS_ORDER } from "../src/sources/adapters/harnesses.ts";

type DocumentType = "user_prompt" | "assistant_final";

interface VectorRow {
  id: RecordId;
  vector: number[];
  input_sha256: string;
  document_id: RecordId;
  document_type: DocumentType;
  harness: string;
  dialogue_id: RecordId;
}

interface PublicMetadata {
  vectorId: string;
  documentId: string;
  dialogueId: string;
  documentType: DocumentType;
  harness: string;
  inputSha256: string;
}

const DIMENSIONS = 3072;
const DOCUMENT_TYPES: readonly DocumentType[] = ["user_prompt", "assistant_final"];

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function selectPopulation(db: Surreal, limit: number): Promise<VectorRow[]> {
  return selectAll<VectorRow>(
    db,
    `SELECT id, vector, input_sha256, search_document.id AS document_id,
       search_document.document_type AS document_type,
       search_document.dialogue.harness_installation.harness.slug AS harness,
       search_document.dialogue.id AS dialogue_id
     FROM search_embedding_main ORDER BY id LIMIT $limit`,
    { limit },
  );
}

async function selectBalanced(db: Surreal, perStratum: number): Promise<VectorRow[]> {
  const rows: VectorRow[] = [];
  for (const harness of HARNESS_ORDER) {
    for (const documentType of DOCUMENT_TYPES) {
      rows.push(...await selectAll<VectorRow>(
        db,
        `SELECT id, vector, input_sha256, search_document.id AS document_id,
           search_document.document_type AS document_type,
           search_document.dialogue.harness_installation.harness.slug AS harness,
           search_document.dialogue.id AS dialogue_id
         FROM search_embedding_main
         WHERE search_document.document_type = $documentType
           AND search_document.dialogue.harness_installation.harness.slug = $harness
         ORDER BY id LIMIT $limit`,
        { documentType, harness, limit: perStratum },
      ));
    }
  }
  return rows;
}

async function writeSample(
  outputDir: string,
  name: string,
  rows: readonly VectorRow[],
): Promise<Record<string, unknown>> {
  const vectorIds = new Set<string>();
  const vectors = new Float32Array(rows.length * DIMENSIONS);
  const metadata: PublicMetadata[] = [];
  for (const [index, row] of rows.entries()) {
    const vectorId = String(row.id);
    if (vectorIds.has(vectorId)) throw new Error(`${name}: duplicate vector id ${vectorId}`);
    if (row.vector.length !== DIMENSIONS) {
      throw new Error(`${name}: vector ${vectorId} has ${row.vector.length}/${DIMENSIONS} dimensions`);
    }
    vectorIds.add(vectorId);
    vectors.set(row.vector, index * DIMENSIONS);
    metadata.push({
      vectorId,
      documentId: String(row.document_id),
      dialogueId: String(row.dialogue_id),
      documentType: row.document_type,
      harness: row.harness,
      inputSha256: row.input_sha256,
    });
  }
  const vectorBytes = new Uint8Array(vectors.buffer);
  const metadataSource = `${JSON.stringify(metadata, null, 2)}\n`;
  const vectorFile = `${name}.f32`;
  const metadataFile = `${name}.metadata.json`;
  await writeFile(path.join(outputDir, vectorFile), vectorBytes, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(outputDir, metadataFile), metadataSource, { flag: "wx", mode: 0o600 });
  return {
    name,
    rows: rows.length,
    dimensions: DIMENSIONS,
    vectorFile,
    vectorBytes: vectorBytes.byteLength,
    vectorSha256: sha256(vectorBytes),
    metadataFile,
    metadataSha256: sha256(metadataSource),
    strata: [...new Set(metadata.map((row) => `${row.harness}:${row.documentType}`))]
      .sort()
      .map((key) => {
        const [harness, documentType] = key.split(":");
        return {
          harness,
          documentType,
          rows: metadata.filter((row) =>
            row.harness === harness && row.documentType === documentType).length,
        };
      }),
  };
}

async function main(): Promise<void> {
  const outputArg = process.argv[2];
  if (!outputArg) throw new Error("usage: vector-cluster-extract <private-output-dir>");
  const outputDir = path.resolve(outputArg);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const db = await connectDb(loadConfig());
  try {
    const [space] = await selectAll<Record<string, unknown>>(
      db,
      "SELECT * FROM embedding_space WHERE active = true LIMIT 1",
    );
    if (!space || space.slug !== "main" || space.dimensions !== DIMENSIONS) {
      throw new Error("active main/3072 embedding space is required");
    }
    const populationRows = await selectPopulation(db, 3_000);
    const balancedRows = await selectBalanced(db, 150);
    const manifest = {
      formatVersion: 1,
      generatedAt: new Date().toISOString(),
      source: {
        table: "search_embedding_main",
        space: {
          slug: space.slug,
          provider: space.provider,
          model: space.model,
          dimensions: space.dimensions,
        },
      },
      privacy: "No dialogue text or search_document content is included.",
      samples: [
        await writeSample(outputDir, "population", populationRows),
        await writeSample(outputDir, "balanced", balancedRows),
      ],
    };
    await writeFile(
      path.join(outputDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    await db.close();
  }
}

await main();
