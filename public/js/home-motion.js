/* Tashkheesa home page — motion fallbacks.
 *
 * The two inline scripts of the approved reference
 * (docs/redesign/home-laptop-reveal.html), moved here verbatim because the
 * site CSP has no 'unsafe-inline' for scripts. Loaded with defer by
 * views/index.ejs.
 *
 * Neither does anything in a browser that has CSS scroll-driven animations:
 * there the opening and the section reveals are pure CSS
 * (public/styles/marketing.css). The first block drives the same keyframes
 * from scroll position using the data-rv="A,B" ranges in
 * views/partials/hero-reveal.ejs; keep its KF table in step with the
 * @keyframes in marketing.css.
 */
/* Fallback for browsers without CSS scroll-driven animations: drive the same keyframes with the Web Animations API. */
(function(){
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (window.CSS && CSS.supports && CSS.supports('animation-timeline: scroll()')) return;
  var KF = {
    'rv-bg':       [{opacity:0},{opacity:.42}],
    'rv-lock':     [{opacity:1},{opacity:0}],
    'rv-cue':      [{opacity:1},{opacity:0}],
    'rv-bar':      [{transform:'scaleX(0)'},{transform:'scaleX(1)'}],
    'rv-head':     [{opacity:0,transform:'translateY(28px)'},{opacity:1,transform:'none'}],
    'rv-laptop':   [{opacity:0,transform:'translateY(160px) scale(.86)'},{opacity:1,transform:'none'}],
    'rv-lid':      [{transform:'rotateX(-102deg)'},{transform:'rotateX(14deg)'}],
    'rv-ui':       [{opacity:0},{opacity:1}],
    'rv-deckglow': [{opacity:0},{opacity:1}],
    'rv-screen':   [{boxShadow:'0 0 0 rgba(11,107,95,0)'},{boxShadow:'0 0 90px rgba(11,107,95,.45)'}]
  };
  var items = [];
  document.querySelectorAll('[data-rv]').forEach(function(el){
    var r = el.getAttribute('data-rv').split(',').map(Number);
    var name = null;
    ['rv-bg','rv-lock','rv-cue','rv-bar','rv-head','rv-laptop','rv-lid','rv-ui','rv-deckglow','rv-screen'].forEach(function(n){ if (el.classList.contains(n)) name = n; });
    var kf;
    if (name) { kf = KF[name]; }
    else {
      var cs = getComputedStyle(el);
      var dx = cs.getPropertyValue('--dx').trim() || '0px', dy = cs.getPropertyValue('--dy').trim() || '0px';
      kf = [{opacity:0,transform:'translate('+dx+','+dy+') scale(.92)'},{opacity:1,transform:'none'}];
    }
    var anim = el.animate(kf, {duration:1000, fill:'both', easing:'linear'});
    anim.pause();
    items.push({a:r[0], b:r[1], anim:anim});
  });
  var ticking = false;
  function update(){
    var y = window.scrollY || window.pageYOffset;
    for (var i=0;i<items.length;i++){
      var it = items[i];
      var p = (y - it.a) / (it.b - it.a);
      p = p < 0 ? 0 : (p > 1 ? 1 : p);
      it.anim.currentTime = p * 1000;
    }
    ticking = false;
  }
  window.addEventListener('scroll', function(){ if(!ticking){ ticking = true; requestAnimationFrame(update); } }, {passive:true});
  update();
})();
/* Section reveals fallback */
(function(){
  if (window.CSS && CSS.supports && CSS.supports('animation-timeline: view()')) return;
  if (!('IntersectionObserver' in window)) return;
  var els = document.querySelectorAll('.reveal');
  els.forEach(function(el){ el.style.opacity = '0'; el.style.transform = 'translateY(18px)'; el.style.transition = 'opacity .8s cubic-bezier(.2,.7,.2,1), transform .8s cubic-bezier(.2,.7,.2,1)'; });
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){ if (e.isIntersecting){ e.target.style.opacity = '1'; e.target.style.transform = 'none'; io.unobserve(e.target); } });
  }, {rootMargin:'0px 0px -15% 0px'});
  els.forEach(function(el){ io.observe(el); });
})();
