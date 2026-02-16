// Portal Tour Engine
(function() {
  'use strict';

  window.PortalTour = {
    currentStep: 0,
    steps: [],
    overlay: null,
    tooltip: null,
    isActive: false,

    // Start a tour
    start: function(tourId, steps) {
      if (this.isActive) return;
      this.tourId = tourId;
      this.steps = steps;
      this.currentStep = 0;
      this.isActive = true;
      this._createOverlay();
      this._showStep(0);
    },

    // Show specific step
    _showStep: function(index) {
      if (index < 0 || index >= this.steps.length) {
        this.end();
        return;
      }
      this.currentStep = index;
      var step = this.steps[index];

      // Remove previous highlight
      var prev = document.querySelector('.tour-highlight');
      if (prev) prev.classList.remove('tour-highlight');

      // Find target element — support comma-separated selectors as fallbacks
      var target = null;
      var selectors = step.target.split(',');
      for (var s = 0; s < selectors.length; s++) {
        try {
          target = document.querySelector(selectors[s].trim());
          if (target) break;
        } catch (e) {
          // Invalid selector, try next
        }
      }

      if (!target) {
        // Skip to next step if target not found
        this._showStep(index + 1);
        return;
      }

      // Scroll target into view
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Highlight target
      var self = this;
      setTimeout(function() {
        target.classList.add('tour-highlight');
        self._positionTooltip(target, step, index);
      }, 300);
    },

    _positionTooltip: function(target, step, index) {
      if (this.tooltip) this.tooltip.remove();

      var rect = target.getBoundingClientRect();
      var pos = step.position || 'bottom';
      var total = this.steps.length;

      // Build tooltip HTML
      var html = '<div class="tour-progress">';
      for (var i = 0; i < total; i++) {
        var cls = i < index ? 'done' : (i === index ? 'active' : '');
        html += '<div class="tour-progress-dot ' + cls + '"></div>';
      }
      html += '</div>';
      html += '<div class="tour-step-label">Step ' + (index + 1) + ' of ' + total + '</div>';
      html += '<div class="tour-title">' + step.title + '</div>';
      html += '<div class="tour-text">' + step.text + '</div>';
      html += '<div class="tour-actions">';
      if (index > 0) {
        html += '<button class="tour-btn tour-btn-secondary" onclick="PortalTour.prev()">Back</button>';
      } else {
        html += '<button class="tour-btn-skip" onclick="PortalTour.end()">Skip tour</button>';
      }
      if (index < total - 1) {
        html += '<button class="tour-btn tour-btn-primary" onclick="PortalTour.next()">Next</button>';
      } else {
        html += '<button class="tour-btn tour-btn-primary" onclick="PortalTour.end()">Finish</button>';
      }
      html += '</div>';

      var tooltip = document.createElement('div');
      tooltip.className = 'tour-tooltip';
      tooltip.setAttribute('data-position', pos);
      tooltip.innerHTML = html;
      document.body.appendChild(tooltip);
      this.tooltip = tooltip;

      // Position tooltip relative to target
      var tooltipRect = tooltip.getBoundingClientRect();
      var gap = 16;
      var top, left;

      if (pos === 'bottom') {
        top = rect.bottom + gap;
        left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
      } else if (pos === 'top') {
        top = rect.top - tooltipRect.height - gap;
        left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
      } else if (pos === 'right') {
        top = rect.top + (rect.height / 2) - (tooltipRect.height / 2);
        left = rect.right + gap;
      } else if (pos === 'left') {
        top = rect.top + (rect.height / 2) - (tooltipRect.height / 2);
        left = rect.left - tooltipRect.width - gap;
      }

      // Clamp to viewport
      left = Math.max(12, Math.min(left, window.innerWidth - tooltipRect.width - 12));
      top = Math.max(12, Math.min(top, window.innerHeight - tooltipRect.height - 12));

      tooltip.style.top = top + 'px';
      tooltip.style.left = left + 'px';
    },

    next: function() { this._showStep(this.currentStep + 1); },
    prev: function() { this._showStep(this.currentStep - 1); },

    end: function() {
      this.isActive = false;
      if (this.overlay) { this.overlay.remove(); this.overlay = null; }
      if (this.tooltip) { this.tooltip.remove(); this.tooltip = null; }
      var prev = document.querySelector('.tour-highlight');
      if (prev) prev.classList.remove('tour-highlight');
      // Mark tour as completed
      if (this.tourId) {
        try { localStorage.setItem('tour_' + this.tourId + '_done', '1'); } catch (e) {}
      }
    },

    _createOverlay: function() {
      if (this.overlay) return;
      this.overlay = document.createElement('div');
      this.overlay.className = 'tour-overlay';
      this.overlay.onclick = function() {}; // Prevent click-through
      document.body.appendChild(this.overlay);
    },

    // Check if tour was completed
    isDone: function(tourId) {
      try { return localStorage.getItem('tour_' + tourId + '_done') === '1'; } catch (e) { return false; }
    },

    // Reset tour state
    reset: function(tourId) {
      try { localStorage.removeItem('tour_' + tourId + '_done'); } catch (e) {}
    },

    // Show welcome modal
    showWelcome: function(options) {
      var tourId = options.tourId;
      if (this.isDone(tourId) && !options.force) return;

      var modal = document.createElement('div');
      modal.className = 'tour-welcome';
      modal.innerHTML =
        '<div class="tour-welcome-card">' +
          '<div class="tour-welcome-icon">' + (options.icon || '') + '</div>' +
          '<div class="tour-welcome-title">' + (options.title || 'Welcome!') + '</div>' +
          '<div class="tour-welcome-text">' + (options.text || 'Take a quick tour?') + '</div>' +
          '<div style="display:flex;gap:12px;justify-content:center;">' +
            '<button class="tour-btn tour-btn-secondary" id="tour-skip-welcome">Maybe later</button>' +
            '<button class="tour-btn tour-btn-primary" id="tour-start-welcome">Start Tour</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(modal);

      document.getElementById('tour-skip-welcome').onclick = function() {
        modal.remove();
        try { localStorage.setItem('tour_' + tourId + '_done', '1'); } catch (e) {}
      };
      document.getElementById('tour-start-welcome').onclick = function() {
        modal.remove();
        if (options.onStart) options.onStart();
      };
    }
  };
})();
