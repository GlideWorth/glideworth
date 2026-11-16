/**
 * Components available in every MDX entry without an import. Each entry route renders
 * <Content components={mdxComponents} />. Importing explicitly in the MDX file also works.
 * `a` and `table` replace the HTML elements Markdown produces: links to other origins get
 * rel="noopener noreferrer" and tables scroll inside their own box (see MdxLink and MdxTable).
 */
import Button from "./Button.astro";
import Callout from "./Callout.astro";
import Card from "./Card.astro";
import CodeBlock from "./CodeBlock.astro";
import FAQ from "./FAQ.astro";
import FeatureGrid from "./FeatureGrid.astro";
import Figure from "./Figure.astro";
import MdxLink from "./MdxLink.astro";
import MdxTable from "./MdxTable.astro";
import RepoLink from "./RepoLink.astro";
import Steps from "./Steps.astro";
import ProjectionFan from "./visuals/ProjectionFan.astro";

export const mdxComponents = {
  a: MdxLink,
  table: MdxTable,
  Button,
  Callout,
  Card,
  CodeBlock,
  FAQ,
  FeatureGrid,
  Figure,
  RepoLink,
  Steps,
  ProjectionFan,
};
