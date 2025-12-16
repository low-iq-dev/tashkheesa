// Smooth scroll for in-page links
document.querySelectorAll('a[href^="#"]').forEach(link => {
  link.addEventListener('click', e => {
    const targetId = link.getAttribute('href');
    if (!targetId || !targetId.startsWith('#')) return;
    const el = document.querySelector(targetId);
    if (!el) return;
    e.preventDefault();
    el.scrollIntoView({ behavior: 'smooth' });
  });
});

// Contact form via Formspree
const contactForm = document.getElementById('contact-form');
if (contactForm) {
  contactForm.addEventListener('submit', async e => {
    e.preventDefault();
    const endpoint = contactForm.dataset.endpoint;
    const btn = contactForm.querySelector('button[type="submit"]');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Sending…';

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
        body: new FormData(contactForm)
      });
      if (res.ok) {
        alert('Message sent. We will get back to you shortly.');
        contactForm.reset();
      } else {
        alert('There was a problem sending your message. Please try again.');
      }
    } catch (err) {
      alert('Network error. Please try again.');
    }

    btn.disabled = false;
    btn.textContent = original;
  });
}