(function () {
  const body = document.body;
  if (!body || body.getAttribute('data-meta-pixel') !== '1') return;

  // Production only. Every other host — localhost, a preview deploy, the
  // *.onrender.com address, a test render — used to load fbevents.js and send a
  // real PageView to the live pixel. Exact match on purpose: a suffix or
  // substring test would also pass for nottashkheesa.com or
  // tashkheesa.com.example.org. (www 301s to the apex in production; it is
  // listed so the first hit before that redirect is not lost if that changes.)
  const host = String((window.location && window.location.hostname) || '').toLowerCase();
  if (host !== 'tashkheesa.com' && host !== 'www.tashkheesa.com') return;

  !function(f,b,e,v,n,t,s)
  {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};
  if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
  n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];
  s.parentNode.insertBefore(t,s)}(window, document,'script',
  'https://connect.facebook.net/en_US/fbevents.js');
  fbq('init', '857477276921931');
  fbq('track', 'PageView');
})();
