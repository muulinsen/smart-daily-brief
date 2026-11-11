# Nginx 部署

1. 安装 Nginx 与 Certbot，并确保 `brief.example.com` 的 A/AAAA 记录指向服务器。
2. 先申请证书：

```bash
sudo mkdir -p /var/www/acme
sudo certbot certonly --webroot -w /var/www/acme -d brief.example.com
```

3. 安装站点并检查配置：

```bash
sudo install -D -m 0644 deploy/nginx/brief.example.com.conf \
  /etc/nginx/sites-available/brief.example.com.conf
sudo ln -sfn /etc/nginx/sites-available/brief.example.com.conf \
  /etc/nginx/sites-enabled/brief.example.com.conf
sudo nginx -t
sudo systemctl reload nginx
```

应用服务必须监听 `127.0.0.1:3000`（`brief-web.service` 默认如此）。公网验证：

```bash
curl -fsS https://brief.example.com/health/live
curl -sSI https://brief.example.com/login
```
