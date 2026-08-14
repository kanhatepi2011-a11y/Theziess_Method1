import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANGELOG_PATH = join(__dirname, "..", "CHANGELOG.md");
const OUTPUT_PATH = join(__dirname, "..", "src", "changelog-data.mjs");

function parseChangelog(markdown) {
    const versionBlocks = markdown.match(
        /## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})\n\n([\s\S]*?)(?=\n## |\n*$)/g,
    );

    if (!versionBlocks) {
        return [];
    }

    return versionBlocks.map((block) => {
        const headerMatch = block.match(
            /## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})/,
        );
        const version = headerMatch[1];
        const date = headerMatch[2];

        const changesSection = block.substring(headerMatch[0].length).trim();
        const changes = changesSection
            .split("\n")
            .filter((line) => line.startsWith("- "))
            .map((line) => {
                const raw = line.substring(2).trim();
                return raw.replace(/^\*\*[^:]+:\*\*\s*/, "");
            });

        return { version, date, changes };
    });
}

function main() {
    try {
        const markdown = readFileSync(CHANGELOG_PATH, "utf-8");
        const changelogData = parseChangelog(markdown);

        mkdirSync(dirname(OUTPUT_PATH), { recursive: true });

        const output = `export const changelogData = ${JSON.stringify(
            changelogData,
            null,
            2,
        )};\n`;
        writeFileSync(OUTPUT_PATH, output, "utf-8");

        console.log(
            `Generated ${OUTPUT_PATH} with ${changelogData.length} version(s)`,
        );
    } catch (error) {
        console.error("Failed to generate changelog:", error.message);
        process.exit(1);
    }
}

main();
