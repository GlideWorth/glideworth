/**
 * Syntax colours for code blocks, drawn from the site palette. Every token colour meets WCAG AA (4.5:1)
 * against the code background of its theme (`--code-bg` in src/styles/tokens.css). Shiki emits both
 * colours as CSS variables (`defaultColor: false`); src/styles/global.css picks one per theme.
 */
interface ShikiTheme {
  name: string;
  type: "light" | "dark";
  colors: Record<string, string>;
  tokenColors: { scope: string[]; settings: { foreground?: string; fontStyle?: string } }[];
}

function theme(
  name: string,
  type: "light" | "dark",
  c: {
    bg: string;
    fg: string;
    comment: string;
    keyword: string;
    string: string;
    number: string;
    fn: string;
    punct: string;
  },
): ShikiTheme {
  return {
    name,
    type,
    colors: { "editor.background": c.bg, "editor.foreground": c.fg },
    tokenColors: [
      {
        scope: ["comment", "punctuation.definition.comment"],
        settings: { foreground: c.comment, fontStyle: "italic" },
      },
      {
        scope: [
          "keyword",
          "storage",
          "storage.type",
          "keyword.operator.new",
          "variable.language",
          "entity.name.tag",
        ],
        settings: { foreground: c.keyword },
      },
      {
        scope: ["string", "string.quoted", "string.template", "markup.inline.raw"],
        settings: { foreground: c.string },
      },
      {
        scope: [
          "constant.numeric",
          "constant.language",
          "constant.other",
          "support.constant",
          "keyword.other.unit",
        ],
        settings: { foreground: c.number },
      },
      {
        scope: [
          "entity.name.function",
          "support.function",
          "meta.function-call",
          "entity.other.attribute-name",
        ],
        settings: { foreground: c.fn },
      },
      {
        scope: ["support.type.property-name", "meta.object-literal.key", "variable.parameter"],
        settings: { foreground: c.fg },
      },
      {
        scope: ["punctuation", "meta.brace", "keyword.operator"],
        settings: { foreground: c.punct },
      },
    ],
  };
}

export const shikiLight = theme("glideworth-light", "light", {
  bg: "#efebe1",
  fg: "#1c2420",
  comment: "#5a6159",
  keyword: "#25574a",
  string: "#7a4e10",
  number: "#963a25",
  fn: "#35577c",
  punct: "#454d48",
});

export const shikiDark = theme("glideworth-dark", "dark", {
  bg: "#1a201d",
  fg: "#e6e2d8",
  comment: "#979d94",
  keyword: "#86c0aa",
  string: "#deaa63",
  number: "#ec9a85",
  fn: "#a3bcdb",
  punct: "#bcc0b6",
});
