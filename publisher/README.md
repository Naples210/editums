# Editums publisher (api.editums.com)

Publishes scheduled posts, runs Maui/AI media, and serves the **public API** and **MCP server**.

- REST: `https://api.editums.com/public/v1` — `Authorization: Bearer ed_live_…` (keys created under Agents / Dev; only SHA-256 hashes are stored in `public.api_keys`, see `../espobase/003_api_keys.sql`). 120 req/min per key.
- MCP (Streamable HTTP, JSON responses): `POST https://api.editums.com/mcp` with the same key. Tools: list_channels, list_posts, create_post, update_post, publish_post, delete_post, get_analytics.

Deploy/update on the VPS (as root):

```bash
EDITUMS_SRC=https://editums.espohost.com/deploy/editums-server.tar.gz bash <(curl -fsSL https://editums.espohost.com/deploy/install.sh)
```
