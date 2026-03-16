# SSH Key Setup for Ops Dashboard → Mac Mini

## 1. Generate a key pair (run this once, anywhere)

```bash
ssh-keygen -t ed25519 -C "render-ops" -f render_ops_key -N ""
```

This creates `render_ops_key` (private) and `render_ops_key.pub` (public).

## 2. Add the public key to the Mac mini

On the Mac mini run:

```bash
cat render_ops_key.pub >> /Users/macmini/.ssh/authorized_keys
chmod 600 /Users/macmini/.ssh/authorized_keys
```

## 3. Test SSH works

```bash
ssh -i render_ops_key macmini@100.106.122.55 "echo ok"
```

## 4. Add env vars to Render

```
OPS_SSH_HOST=100.106.122.55
OPS_SSH_USER=macmini
OPS_SSH_KEY_PATH=/etc/secrets/render_ops_key
```

## 5. Add private key as a Render Secret File

Render Dashboard → your service → Secret Files → add file at `/etc/secrets/render_ops_key`

Paste the contents of `render_ops_key` (private key, not `.pub`).
