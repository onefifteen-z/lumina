import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkHtml from "remark-html";
import remarkWikilinks from "../plugins/remark-wikilinks";
import remarkEmbeds from "../plugins/remark-embeds";
import remarkTags from "../plugins/remark-tags";

/** Same remark → HTML pipeline as the article reader (`ArticleBrowser`). */
export function markdownArticleBodyToHtml(markdown: string): string {
  const result = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkWikilinks)
    .use(remarkEmbeds)
    .use(remarkTags)
    .use(remarkHtml, { sanitize: false })
    .processSync(markdown);
  return String(result);
}
