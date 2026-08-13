import { readFileSync, readdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { CHAPTERS, SHOTS } from "./guide-shots.js";

/**
 * The guide is a public artefact, so its failure modes are a broken image and
 * a stale picture nothing references. Both are cheap to detect and impossible
 * to notice by eye once there are fifteen of them.
 *
 * What is deliberately NOT checked: whether a sentence still describes the
 * screen beside it. Nothing can check that. The mitigation is procedural —
 * when a page changes, its chapter changes in the same commit — and it is
 * stated in the spec so it is not mistaken for an oversight.
 */

const GUIDE = "docs/guide";

function chapterSources(): { slug: string; body: string }[] {
  const missing: string[] = [];
  const sources: { slug: string; body: string }[] = [];

  for (const chapter of CHAPTERS) {
    const path = `${GUIDE}/${chapter.slug}.md`;
    try {
      const body = readFileSync(path, "utf8");
      sources.push({ slug: chapter.slug, body });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missing.push(chapter.slug);
      } else {
        throw error;
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(`chapters missing from ${GUIDE}: ${missing.join(", ")}`);
  }

  return sources;
}

test("every chapter named in the shot list exists", () => {
  const present = new Set(
    readdirSync(GUIDE).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")),
  );
  const missing = CHAPTERS.map((c) => c.slug).filter((slug) => !present.has(slug));
  expect(missing, `chapters missing from ${GUIDE}: ${missing.join(", ")}`).toEqual([]);
});

test("every image a chapter references exists on disk", () => {
  const files = new Set(readdirSync(`${GUIDE}/images`));
  const broken: string[] = [];

  for (const { slug, body } of chapterSources()) {
    for (const match of body.matchAll(/!\[[^\]]*\]\(images\/([^)]+)\)/g)) {
      if (!files.has(match[1]!)) broken.push(`${slug}.md → ${match[1]}`);
    }
  }

  expect(broken, `broken image references: ${broken.join(", ")}`).toEqual([]);
});

test("every captured image is referenced by some chapter", () => {
  const referenced = new Set<string>();
  for (const { body } of chapterSources()) {
    for (const match of body.matchAll(/!\[[^\]]*\]\(images\/([^)]+)\)/g)) {
      referenced.add(match[1]!);
    }
  }

  const orphans = readdirSync(`${GUIDE}/images`)
    .filter((file) => file.endsWith(".png"))
    .filter((file) => !referenced.has(file));

  expect(
    orphans,
    `images nothing references — a renamed shot or a deleted chapter left ` +
      `these behind: ${orphans.join(", ")}`,
  ).toEqual([]);
});

test("the manifest matches the shot list", () => {
  const manifest = JSON.parse(readFileSync(`${GUIDE}/manifest.json`, "utf8")) as {
    shots: { id: string }[];
  };
  expect(manifest.shots.map((s) => s.id).sort()).toEqual(SHOTS.map((s) => s.id).sort());
});
