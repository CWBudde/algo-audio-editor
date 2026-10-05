import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Copy, Play } from "./icons";
import * as generatedIcons from "./shadcn-icons";

afterEach(cleanup);

it("resolves the generated import specifier to the local compatibility facade", async () => {
  expect(await vi.importActual("lucide-react")).toEqual(generatedIcons);
});

it("keeps removed artwork and fonts out of the web dependency manifest", () => {
  const packageFile = resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json");
  const manifest = JSON.parse(readFileSync(packageFile, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  for (const dependencies of [manifest.dependencies, manifest.devDependencies]) {
    expect(dependencies).not.toHaveProperty("lucide-react");
    expect(dependencies).not.toHaveProperty("@fontsource-variable/geist");
  }
  expect(manifest.dependencies).toHaveProperty("@heroicons/react", "2.2.0");
});

it("renders scalable currentColor artwork without adding accessible text", () => {
  const ui = render(<Copy className="size-4" aria-hidden="true" />);
  const svg = ui.container.querySelector("svg");
  expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
  expect(svg?.getAttribute("stroke")).toBe("currentColor");
  expect(svg?.getAttribute("class")).toBe("size-4");
  expect(svg?.getAttribute("aria-hidden")).toBe("true");
  expect(svg?.hasAttribute("width")).toBe(false);
  expect(svg?.hasAttribute("height")).toBe(false);
  expect(ui.container.textContent).toBe("");
});

it("forwards refs and SVG props used by toolbar controls", () => {
  let node: SVGSVGElement | null = null;
  const ui = render(
    <Play
      ref={(svg) => {
        node = svg;
      }}
      className="size-4"
      data-testid="play-icon"
      strokeWidth={2}
    />,
  );
  expect(node).toBe(ui.getByTestId("play-icon"));
  expect(ui.getByTestId("play-icon").getAttribute("stroke-width")).toBe("2");
});

it("maps every generated icon import and confines compatibility names to generated UI", () => {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../");
  const generatedNames = new Set<string>();
  for (const relativePath of readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })) {
    if (!/\.(?:ts|tsx)$/.test(relativePath)) continue;
    const source = readFileSync(resolve(sourceRoot, relativePath), "utf8");
    const generated = relativePath.replaceAll("\\", "/").startsWith("components/ui/");
    if (!generated) {
      expect(source, relativePath).not.toMatch(
        /(?:\bfrom\s*|\bimport\s*\()["']lucide-react(?:\/[^"']*)?["']/,
      );
    }
    const imports = source.matchAll(/import\s+\{([^}]+)\}\s+from\s+["']lucide-react["']/g);
    for (const match of imports) {
      expect(generated).toBe(true);
      const [, namedImports = ""] = match;
      for (const specifier of namedImports.split(",")) {
        const [name = ""] = specifier.trim().split(/\s+as\s+/);
        expect(generatedIcons, `${relativePath}: ${name}`).toHaveProperty(name);
        generatedNames.add(name);
      }
    }
    // No Lucide subpaths can bypass the exact facade alias.
    expect(source).not.toMatch(/from\s+["']lucide-react\//);
  }
  expect(generatedNames.size).toBeGreaterThan(0);
});
