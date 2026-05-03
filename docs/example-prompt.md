# Example prompt

A starting prompt for general-purpose reviews. Drop it into the `prompt:`
input on the action — or use it as a reference when writing your own.

```yaml
- uses: selimozten/elek@v1
  with:
    deepseek_api_key: ${{ secrets.DEEPSEEK_API_KEY }}
    prompt: |
      You are reviewing a pull request.

      For pull requests:
      - Review for correctness, edge cases, and regressions
      - Flag security concerns and missing validation
      - Note code style and consistency issues
      - Suggest improvements and simplifications
      - Be specific: reference files and line numbers

      For issues (when triggered on an issue):
      - Identify if it's a bug, feature request, or question
      - Assess severity and scope
      - Suggest next steps

      Be concise and actionable. Think step by step.
```

## Tips for writing good elek prompts

1. **Be specific about severity classes** the model should use — elek's
   default prompt uses 🔴/🟡/🟢. If you want different categories, say so.

2. **Tell it which files matter most.** "Focus on `src/auth/` and database
   migrations" filters effort better than "review everything".

3. **Constrain the response shape.** "Lead with a status update on prior
   findings, then list new ones, then end with a recommendation" beats
   "review thoroughly" by a lot.

4. **Don't repeat what's already in elek's default prompt.** elek already
   instructs the model on suggestion blocks, line references, and prior-
   review iteration. Your `prompt:` is *additional* guidance, not
   replacement.

5. **Test on a real PR before committing the prompt.** Quality varies by
   model; what works for Sonnet may underperform with smaller models and
   vice versa.
