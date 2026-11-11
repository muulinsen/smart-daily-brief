-- 订阅地址的访问令牌。日报 RSS 首次上线时自动生成一个 256 位令牌；后台可重置或撤销（置 NULL）。
CREATE TABLE feed_tokens (
  name       TEXT PRIMARY KEY,
  token      TEXT UNIQUE,
  rotated_at TEXT NOT NULL
) STRICT;
INSERT INTO feed_tokens(name, token, rotated_at)
VALUES ('briefs', lower(hex(randomblob(32))), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
