import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { htmlToText } from "../connector/html.js";

describe("htmlToText", () => {
  it("returns empty string for empty input", () => {
    assert.equal(htmlToText(""), "");
  });

  it("strips simple tags", () => {
    assert.equal(htmlToText("<p>Hello</p>"), "Hello");
    assert.equal(htmlToText("<div><span>a</span><span>b</span></div>"), "a b");
  });

  it("decodes common HTML entities", () => {
    assert.equal(htmlToText("AT&amp;T"), "AT&T");
    assert.equal(htmlToText("&lt;tag&gt;"), "<tag>");
    assert.equal(htmlToText("&quot;quoted&quot;"), '"quoted"');
    assert.equal(htmlToText("it&#39;s"), "it's");
    assert.equal(htmlToText("a&nbsp;b"), "a b");
  });

  it("collapses whitespace", () => {
    assert.equal(htmlToText("<p>foo\n\n  bar  \tbaz</p>"), "foo bar baz");
  });

  it("respects maxLength parameter", () => {
    const long = "<p>" + "abcdefghij".repeat(200) + "</p>";
    const out = htmlToText(long, 100);
    assert.equal(out.length, 100);
  });

  it("uses default maxLength of 1500", () => {
    const long = "x".repeat(2000);
    assert.equal(htmlToText(long).length, 1500);
  });

  it("handles nested tags + entities + whitespace together", () => {
    const input =
      "<div>\n  <p>Hello &amp; <strong>welcome</strong>&nbsp;to <em>Acme</em>!</p>\n</div>";
    // Tag boundaries become spaces, so adjacent punctuation gets a single
    // space inserted before it. That's acceptable for a description excerpt.
    assert.equal(htmlToText(input), "Hello & welcome to Acme !");
  });
});
