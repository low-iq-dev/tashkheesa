# Quick Fix: Remove "Home" from Nav Bar

In ALL 5 public HTML files (`public/index.html`, `public/services.html`, `public/about.html`, `public/doctors.html`, `public/contact.html`):

Delete this line from the `<div class="nav-links">` section:
```html
        <a href="/site/">Home</a>
```

Only remove it from the NAV, NOT from the footer Quick Links section.

Commit: `fix: remove redundant Home link from nav bar`
