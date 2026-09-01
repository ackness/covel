import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCli, validateNewLocale } from "./add-locale.mjs";
import {
  canonicalizeCatalogLocale,
  checkLocaleCatalogs,
} from "./check-locale-catalogs.mjs";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const PNPM_COMMAND = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function withCatalogs(catalogs, check) {
  const directory = mkdtempSync(join(tmpdir(), "covel-locale-test-"));
  try {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      writeFileSync(
        join(directory, `${locale}.json`),
        `${JSON.stringify(catalog)}\n`,
        "utf8",
      );
    }
    check(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const englishPluralCatalog = {
  itemCount: "{{count}} items",
  itemCount_one: "{{count}} item",
};

test("catalog checker accepts and requires locale-specific plural categories", () => {
  withCatalogs(
    {
      "en-US": englishPluralCatalog,
      "ru-RU": {
        itemCount: "{{count}} элементов",
        itemCount_one: "{{count}} элемент",
        itemCount_few: "{{count}} элемента",
        itemCount_many: "{{count}} элементов",
      },
    },
    (directory) => assert.deepEqual(checkLocaleCatalogs(directory), []),
  );

  withCatalogs(
    {
      "en-US": englishPluralCatalog,
      "ru-RU": {
        itemCount: "{{count}} элементов",
        itemCount_one: "{{count}} элемент",
      },
    },
    (directory) => {
      const problems = checkLocaleCatalogs(directory);
      assert.ok(
        problems.some((problem) =>
          problem.includes('missing plural category "few"'),
        ),
      );
      assert.ok(
        problems.some((problem) =>
          problem.includes('missing plural category "many"'),
        ),
      );
    },
  );
});

test("catalog checker still rejects unrelated extra keys", () => {
  withCatalogs(
    {
      "en-US": englishPluralCatalog,
      "ja-JP": {
        ...englishPluralCatalog,
        unrelated: "余分",
      },
    },
    (directory) => {
      assert.ok(
        checkLocaleCatalogs(directory).includes(
          'ja-JP.json has unknown catalog key "unrelated"',
        ),
      );
    },
  );
});

test("catalog checker validates interpolation in locale-specific plurals", () => {
  withCatalogs(
    {
      "en-US": englishPluralCatalog,
      "ru-RU": {
        itemCount: "{{count}} элементов",
        itemCount_one: "{{count}} элемент",
        itemCount_few: "{{total}} элемента",
        itemCount_many: "{{count}} элементов",
      },
    },
    (directory) => {
      assert.ok(
        checkLocaleCatalogs(directory).some(
          (problem) =>
            problem.includes('key "itemCount_few"') &&
            problem.includes("interpolation tokens [total]"),
        ),
      );
    },
  );
});

test("catalog checker allows plurals for an unmarked count interpolation", () => {
  withCatalogs(
    {
      "en-US": { logCount: "{{count}} logs" },
      "ru-RU": {
        logCount: "Журналов: {{count}}",
        logCount_one: "{{count}} журнал",
        logCount_few: "{{count}} журнала",
        logCount_many: "{{count}} журналов",
      },
    },
    (directory) => assert.deepEqual(checkLocaleCatalogs(directory), []),
  );
});

test("catalog checker rejects contributed codes owned by built-in aliases", () => {
  withCatalogs(
    {
      "en-US": { value: "English" },
      "zh-CN": { value: "中文" },
      "zh-Hans": { value: "简体中文" },
    },
    (directory) => {
      assert.ok(
        checkLocaleCatalogs(directory).some((problem) =>
          problem.includes(
            "zh-Hans.json conflicts with built-in locale alias zh-Hans owned by zh-CN.json",
          ),
        ),
      );
    },
  );
});

test("locale scaffold rejects alias conflicts before writing a catalog", () => {
  const existing = ["zh-CN", "en-US", "ru-RU"];
  for (const alias of ["zh", "zh-Hans", "en", "ru"]) {
    assert.throws(
      () => validateNewLocale(alias, existing),
      /conflicts with a built-in alias/,
    );
  }
  assert.equal(validateNewLocale("ja_JP", existing), "ja-JP");
  assert.equal(
    validateNewLocale("en-u-ca-gregory", existing),
    "en-u-ca-gregory",
  );
});

test("catalog locale envelope accepts extensions and rejects oversized tags", () => {
  assert.equal(canonicalizeCatalogLocale("en-u-ca-gregory"), "en-u-ca-gregory");
  const oversized = `en-US-x-${Array.from({ length: 8 }, () => "abcdefgh").join("-")}`;
  assert.ok(oversized.length > 64);
  assert.equal(canonicalizeCatalogLocale(oversized), undefined);
  assert.throws(
    () => validateNewLocale(oversized, ["en-US"]),
    /safe BCP 47 language tag/,
  );
});

test("locale scaffold rejects malformed CLI arguments", () => {
  for (const [args, expectedError] of [
    [["pl-PL", "--locales-dir"], /requires a directory value/],
    [["pl-PL", "--unknown"], /Unknown option/],
    [["pl-PL", "extra"], /Unexpected extra argument/],
  ]) {
    const errors = [];
    assert.equal(
      runCli(args, { log() {}, error: (message) => errors.push(message) }),
      1,
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], expectedError);
  }
});

test("root locale scaffold CLI output immediately passes the catalog checker", () => {
  withCatalogs({ "en-US": englishPluralCatalog }, (directory) => {
    const result = spawnSync(
      PNPM_COMMAND,
      ["i18n:add", "pl-PL", "--locales-dir", directory],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        env: process.env,
      },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, {
      stdout: result.stdout,
      stderr: result.stderr,
    });
    assert.ok(result.stdout.includes(join(directory, "pl-PL.json")));
    const catalog = JSON.parse(
      readFileSync(join(directory, "pl-PL.json"), "utf8"),
    );
    assert.equal(catalog.itemCount_one, "{{count}} item");
    assert.equal(catalog.itemCount_few, "{{count}} items");
    assert.equal(catalog.itemCount_many, "{{count}} items");
    assert.deepEqual(checkLocaleCatalogs(directory), []);
  });
});
