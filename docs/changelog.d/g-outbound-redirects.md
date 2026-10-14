### Security

- **Covel's own requests no longer follow redirects.** The model database download and the desktop version check followed a redirect to wherever it pointed, past the address checks, so an answer that redirected to an internal address (such as a cloud metadata service) was fetched. Every framework request now fails on a redirect unless its code checks each hop itself, and the version check reads the release answer with the same size ceiling as other provider answers. Rule: `docs/internals/security.md#redirects`.
