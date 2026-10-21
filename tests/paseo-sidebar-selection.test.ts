import { expect, test } from "bun:test";
import { activeLightTheme } from "../integrations/paseo/client/sidebar-selection";
import { tetherThemes } from "../integrations/paseo/client/themes";

const vars = (id: string) => {
  const c = tetherThemes.find(t => t.id === id)!.colors;
  const map: Record<string, string> = { "--colors-surface0": ` ${c.background.toUpperCase()}`, "--colors-foreground": c.foreground, "--colors-accent": c.accent! };
  return (name: string) => map[name] ?? "";
};

test("sidebar selection override applies only to Tether's light themes", () => {
  expect(activeLightTheme(vars("tether"))).toBe("tether");
  expect(activeLightTheme(vars("light-treason"))).toBe("light-treason");
  expect(activeLightTheme(vars("tether-dark"))).toBeNull();
  expect(activeLightTheme(() => "")).toBeNull();
});
