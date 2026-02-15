/**
 * ImageAnnotator — Medical Image Annotation Tool
 * Built on Fabric.js for the Tashkheesa portal.
 *
 * Usage:
 *   const annotator = new ImageAnnotator('container-id', {
 *     imageUrl: '/files/abc123',
 *     imageId: 'abc123',
 *     caseId: 'case456',
 *     doctorId: 'doc789',
 *     csrfToken: '...',
 *     readOnly: false,
 *     lang: 'en',
 *     onSave: (data) => { ... },
 *     onCancel: () => { ... }
 *   });
 */
(function (root) {
  'use strict';

  var COLORS = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ffffff', '#000000'];
  var DEFAULT_STROKE = 3;
  var ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
  var MAX_HISTORY = 50;

  function ImageAnnotator(containerId, opts) {
    opts = opts || {};
    this.containerEl = document.getElementById(containerId);
    if (!this.containerEl) throw new Error('ImageAnnotator: container #' + containerId + ' not found');

    this.imageUrl = opts.imageUrl || null;
    this.imageId = opts.imageId || '';
    this.caseId = opts.caseId || '';
    this.doctorId = opts.doctorId || '';
    this.csrfToken = opts.csrfToken || '';
    this.readOnly = !!opts.readOnly;
    this.lang = opts.lang || 'en';
    this.onSave = opts.onSave || null;
    this.onCancel = opts.onCancel || null;
    this.existingAnnotation = opts.existingAnnotation || null;

    this.canvas = null;
    this.bgImage = null;
    this.currentTool = 'select';
    this.currentColor = COLORS[0];
    this.strokeWidth = DEFAULT_STROKE;
    this.zoomLevel = 1;
    this.isPanning = false;
    this.panStart = { x: 0, y: 0 };
    this.isDrawingShape = false;
    this.shapeOrigin = null;
    this.activeShape = null;
    this.history = [];
    this.historyIdx = -1;
    this.saving = false;
    this._els = {};

    this._build();
    this._initCanvas();
    this._bindEvents();

    if (this.imageUrl) {
      this.loadImage(this.imageUrl);
    }
  }

  // ── Build DOM ─────────────────────────────────────────
  ImageAnnotator.prototype._build = function () {
    var isAr = this.lang === 'ar';
    var c = this.containerEl;
    c.classList.add('annotator-container');
    if (isAr) c.setAttribute('dir', 'rtl');

    c.innerHTML = '';

    // Toolbar
    var toolbar = el('div', 'annotator-toolbar');

    // Tool buttons
    var tools = [
      { id: 'select', icon: '&#9995;', label: isAr ? 'تحديد' : 'Select' },
      { id: 'pen',    icon: '&#9998;', label: isAr ? 'قلم' : 'Pen' },
      { id: 'circle', icon: '&#9711;', label: isAr ? 'دائرة' : 'Circle' },
      { id: 'rect',   icon: '&#9645;', label: isAr ? 'مستطيل' : 'Rect' },
      { id: 'arrow',  icon: '&#10132;', label: isAr ? 'سهم' : 'Arrow' },
      { id: 'text',   icon: 'T',       label: isAr ? 'نص' : 'Text' }
    ];

    var toolGroup = el('div', 'annotator-tool-group');
    this._els.toolBtns = {};
    for (var i = 0; i < tools.length; i++) {
      var t = tools[i];
      var btn = el('button', 'tool-btn' + (t.id === this.currentTool ? ' active' : ''));
      btn.dataset.tool = t.id;
      btn.innerHTML = '<span class="tool-icon">' + t.icon + '</span><span class="tool-label">' + t.label + '</span>';
      btn.title = t.label;
      if (this.readOnly && t.id !== 'select') btn.disabled = true;
      toolGroup.appendChild(btn);
      this._els.toolBtns[t.id] = btn;
    }
    toolbar.appendChild(toolGroup);

    toolbar.appendChild(el('div', 'annotator-divider'));

    // Color palette
    var colorGroup = el('div', 'annotator-color-group');
    var colorLabel = el('span', 'annotator-group-label');
    colorLabel.textContent = isAr ? 'اللون' : 'Color';
    colorGroup.appendChild(colorLabel);
    var colorPicker = el('div', 'color-picker');
    this._els.swatches = [];
    for (var j = 0; j < COLORS.length; j++) {
      var sw = el('div', 'color-swatch' + (COLORS[j] === this.currentColor ? ' active' : ''));
      sw.style.background = COLORS[j];
      sw.dataset.color = COLORS[j];
      if (COLORS[j] === '#ffffff') sw.classList.add('swatch-light');
      colorPicker.appendChild(sw);
      this._els.swatches.push(sw);
    }
    colorGroup.appendChild(colorPicker);
    toolbar.appendChild(colorGroup);

    toolbar.appendChild(el('div', 'annotator-divider'));

    // Stroke width
    var strokeGroup = el('div', 'annotator-stroke-group');
    var strokeLabel = el('span', 'annotator-group-label');
    strokeLabel.textContent = isAr ? 'السُمك' : 'Stroke';
    strokeGroup.appendChild(strokeLabel);
    var strokeRange = el('input', 'annotator-stroke-range');
    strokeRange.type = 'range';
    strokeRange.min = '1';
    strokeRange.max = '20';
    strokeRange.value = String(this.strokeWidth);
    strokeGroup.appendChild(strokeRange);
    var strokeVal = el('span', 'annotator-stroke-val');
    strokeVal.textContent = this.strokeWidth + 'px';
    strokeGroup.appendChild(strokeVal);
    this._els.strokeRange = strokeRange;
    this._els.strokeVal = strokeVal;
    toolbar.appendChild(strokeGroup);

    toolbar.appendChild(el('div', 'annotator-divider'));

    // Zoom controls
    var zoomGroup = el('div', 'annotator-zoom-group');
    var zoomOut = el('button', 'zoom-btn');
    zoomOut.innerHTML = '&#8722;';
    zoomOut.title = 'Zoom out';
    zoomOut.dataset.zoom = 'out';
    zoomGroup.appendChild(zoomOut);

    var zoomPct = el('span', 'zoom-percentage');
    zoomPct.textContent = '100%';
    zoomGroup.appendChild(zoomPct);
    this._els.zoomPct = zoomPct;

    var zoomIn = el('button', 'zoom-btn');
    zoomIn.innerHTML = '&#43;';
    zoomIn.title = 'Zoom in';
    zoomIn.dataset.zoom = 'in';
    zoomGroup.appendChild(zoomIn);

    var zoomFit = el('button', 'zoom-btn zoom-fit-btn');
    zoomFit.textContent = isAr ? 'ملائمة' : 'Fit';
    zoomFit.dataset.zoom = 'fit';
    zoomGroup.appendChild(zoomFit);

    toolbar.appendChild(zoomGroup);

    toolbar.appendChild(el('div', 'annotator-divider'));

    // Actions: undo, redo, delete, clear
    var actionGroup = el('div', 'annotator-action-group');

    var undoBtn = el('button', 'action-btn');
    undoBtn.innerHTML = '&#8630; ' + (isAr ? 'تراجع' : 'Undo');
    undoBtn.id = 'annotator-undo';
    undoBtn.disabled = true;
    actionGroup.appendChild(undoBtn);
    this._els.undoBtn = undoBtn;

    var redoBtn = el('button', 'action-btn');
    redoBtn.innerHTML = '&#8631; ' + (isAr ? 'إعادة' : 'Redo');
    redoBtn.id = 'annotator-redo';
    redoBtn.disabled = true;
    actionGroup.appendChild(redoBtn);
    this._els.redoBtn = redoBtn;

    var delBtn = el('button', 'action-btn');
    delBtn.innerHTML = '&#128465; ' + (isAr ? 'حذف' : 'Delete');
    delBtn.id = 'annotator-delete';
    delBtn.disabled = true;
    actionGroup.appendChild(delBtn);
    this._els.delBtn = delBtn;

    var clearBtn = el('button', 'action-btn danger');
    clearBtn.innerHTML = '&#128465; ' + (isAr ? 'مسح الكل' : 'Clear All');
    clearBtn.id = 'annotator-clear';
    actionGroup.appendChild(clearBtn);
    this._els.clearBtn = clearBtn;

    toolbar.appendChild(actionGroup);
    c.appendChild(toolbar);

    // Canvas wrapper
    var canvasWrap = el('div', 'annotator-canvas-wrap');
    var canvasEl = document.createElement('canvas');
    canvasEl.id = 'annotator-canvas-' + Date.now();
    canvasWrap.appendChild(canvasEl);
    c.appendChild(canvasWrap);
    this._els.canvasWrap = canvasWrap;
    this._els.canvasEl = canvasEl;

    // Footer
    if (!this.readOnly) {
      var footer = el('div', 'annotator-footer');

      var cancelBtn2 = el('button', 'ann-btn ann-btn-ghost');
      cancelBtn2.textContent = isAr ? 'إلغاء' : 'Cancel';
      cancelBtn2.id = 'annotator-cancel';
      footer.appendChild(cancelBtn2);

      var exportBtn = el('button', 'ann-btn ann-btn-secondary');
      exportBtn.textContent = isAr ? 'تحميل صورة' : 'Download Image';
      exportBtn.id = 'annotator-export';
      footer.appendChild(exportBtn);

      var saveBtn = el('button', 'ann-btn ann-btn-primary');
      saveBtn.textContent = isAr ? 'حفظ التعليقات' : 'Save Annotations';
      saveBtn.id = 'annotator-save';
      footer.appendChild(saveBtn);

      c.appendChild(footer);
    }

    // Status bar
    var statusBar = el('div', 'annotator-status');
    var statusText = el('span', 'annotator-status-text');
    statusText.textContent = isAr ? 'جاهز' : 'Ready';
    statusBar.appendChild(statusText);
    this._els.statusText = statusText;
    c.appendChild(statusBar);
  };

  // ── Init Fabric.js Canvas ─────────────────────────────
  ImageAnnotator.prototype._initCanvas = function () {
    var wrap = this._els.canvasWrap;
    var w = wrap.clientWidth || 800;
    var h = wrap.clientHeight || 600;

    this.canvas = new fabric.Canvas(this._els.canvasEl.id, {
      width: w,
      height: h,
      selection: this.currentTool === 'select',
      isDrawingMode: false,
      backgroundColor: '#1a1a2e',
      preserveObjectStacking: true
    });

    this.canvas.freeDrawingBrush.color = this.currentColor;
    this.canvas.freeDrawingBrush.width = this.strokeWidth;

    this._saveHistory();
  };

  // ── Load Image ────────────────────────────────────────
  ImageAnnotator.prototype.loadImage = function (url) {
    var self = this;
    this._setStatus(this.lang === 'ar' ? 'جاري تحميل الصورة...' : 'Loading image...');

    fabric.Image.fromURL(url, function (img) {
      if (!img || !img.width) {
        self._setStatus(self.lang === 'ar' ? 'فشل تحميل الصورة' : 'Failed to load image');
        return;
      }

      self.bgImage = img;
      var cw = self.canvas.getWidth();
      var ch = self.canvas.getHeight();
      var scale = Math.min(cw / img.width, ch / img.height, 1);

      img.set({
        scaleX: scale,
        scaleY: scale,
        originX: 'center',
        originY: 'center',
        left: cw / 2,
        top: ch / 2,
        selectable: false,
        evented: false,
        erasable: false
      });

      self.canvas.setBackgroundImage(img, function () {
        self.canvas.renderAll();
        self._setStatus(self.lang === 'ar' ? 'جاهز — حدد أداة وابدأ الرسم' : 'Ready — pick a tool and start drawing');

        // Load existing annotation if provided
        if (self.existingAnnotation) {
          self._loadAnnotationState(self.existingAnnotation);
        }

        self._saveHistory();
      });
    }, { crossOrigin: 'anonymous' });
  };

  // ── Bind Events ───────────────────────────────────────
  ImageAnnotator.prototype._bindEvents = function () {
    var self = this;

    // Tool buttons
    this.containerEl.addEventListener('click', function (e) {
      var toolBtn = e.target.closest('.tool-btn');
      if (toolBtn && !toolBtn.disabled) {
        self.selectTool(toolBtn.dataset.tool);
        return;
      }

      var swatch = e.target.closest('.color-swatch');
      if (swatch) {
        self.setColor(swatch.dataset.color);
        return;
      }

      var zoomBtn = e.target.closest('.zoom-btn');
      if (zoomBtn) {
        var dir = zoomBtn.dataset.zoom;
        if (dir === 'in') self.zoomIn();
        else if (dir === 'out') self.zoomOut();
        else if (dir === 'fit') self.zoomToFit();
        return;
      }

      // Action buttons
      if (e.target.closest('#annotator-undo')) { self.undo(); return; }
      if (e.target.closest('#annotator-redo')) { self.redo(); return; }
      if (e.target.closest('#annotator-delete')) { self.deleteSelected(); return; }
      if (e.target.closest('#annotator-clear')) { self.clearAll(); return; }
      if (e.target.closest('#annotator-save')) { self.save(); return; }
      if (e.target.closest('#annotator-export')) { self.exportImage(); return; }
      if (e.target.closest('#annotator-cancel')) {
        if (self.onCancel) self.onCancel();
        return;
      }
    });

    // Stroke width
    this._els.strokeRange.addEventListener('input', function () {
      self.strokeWidth = parseInt(this.value, 10);
      self._els.strokeVal.textContent = self.strokeWidth + 'px';
      if (self.canvas.isDrawingMode) {
        self.canvas.freeDrawingBrush.width = self.strokeWidth;
      }
    });

    // Canvas events for shape drawing
    this.canvas.on('mouse:down', function (o) { self._onMouseDown(o); });
    this.canvas.on('mouse:move', function (o) { self._onMouseMove(o); });
    this.canvas.on('mouse:up',   function (o) { self._onMouseUp(o); });
    this.canvas.on('mouse:wheel', function (o) { self._onMouseWheel(o); });

    // Selection events
    this.canvas.on('selection:created',  function () { self._updateDeleteBtn(); });
    this.canvas.on('selection:updated',  function () { self._updateDeleteBtn(); });
    this.canvas.on('selection:cleared',  function () { self._updateDeleteBtn(); });

    // After drawing in free-draw mode, save history
    this.canvas.on('path:created', function () { self._saveHistory(); });

    // Object modified (move, scale, rotate)
    this.canvas.on('object:modified', function () { self._saveHistory(); });

    // Keyboard shortcuts
    document.addEventListener('keydown', function (e) {
      if (!self.containerEl.contains(document.activeElement) &&
          document.activeElement !== document.body) return;

      var ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === 'z' && !e.shiftKey) { e.preventDefault(); self.undo(); }
      if (ctrl && e.key === 'z' && e.shiftKey)  { e.preventDefault(); self.redo(); }
      if (ctrl && e.key === 'y')                 { e.preventDefault(); self.redo(); }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (document.activeElement.tagName !== 'INPUT' &&
            document.activeElement.tagName !== 'TEXTAREA') {
          self.deleteSelected();
        }
      }
      if (e.key === 'Escape') { self.selectTool('select'); }
    });

    // Resize
    window.addEventListener('resize', function () { self._resizeCanvas(); });
  };

  // ── Tool Selection ────────────────────────────────────
  ImageAnnotator.prototype.selectTool = function (tool) {
    this.currentTool = tool;

    // Update button states
    var btns = this._els.toolBtns;
    for (var k in btns) {
      btns[k].classList.toggle('active', k === tool);
    }

    // Configure canvas
    this.canvas.isDrawingMode = (tool === 'pen');
    this.canvas.selection = (tool === 'select');

    if (tool === 'pen') {
      this.canvas.freeDrawingBrush.color = this.currentColor;
      this.canvas.freeDrawingBrush.width = this.strokeWidth;
    }

    // Set cursor
    if (tool === 'select') {
      this.canvas.defaultCursor = 'default';
      this.canvas.hoverCursor = 'move';
    } else if (tool === 'pen') {
      this.canvas.defaultCursor = 'crosshair';
    } else {
      this.canvas.defaultCursor = 'crosshair';
      this.canvas.hoverCursor = 'crosshair';
    }

    // Deselect all objects when switching to drawing tools
    if (tool !== 'select') {
      this.canvas.discardActiveObject();
      this.canvas.renderAll();
    }

    // Make objects selectable or not
    this.canvas.forEachObject(function (obj) {
      obj.selectable = (tool === 'select');
      obj.evented = (tool === 'select');
    });
  };

  // ── Color ─────────────────────────────────────────────
  ImageAnnotator.prototype.setColor = function (color) {
    this.currentColor = color;
    for (var i = 0; i < this._els.swatches.length; i++) {
      this._els.swatches[i].classList.toggle('active', this._els.swatches[i].dataset.color === color);
    }
    if (this.canvas.isDrawingMode) {
      this.canvas.freeDrawingBrush.color = color;
    }
  };

  // ── Mouse Handlers for Shapes ─────────────────────────
  ImageAnnotator.prototype._onMouseDown = function (o) {
    if (this.currentTool === 'select' || this.currentTool === 'pen') return;

    var pointer = this.canvas.getPointer(o.e);
    this.isDrawingShape = true;
    this.shapeOrigin = { x: pointer.x, y: pointer.y };

    if (this.currentTool === 'text') {
      this._addText(pointer);
      this.isDrawingShape = false;
      return;
    }

    // Create preview shape
    var props = {
      left: pointer.x,
      top: pointer.y,
      fill: 'transparent',
      stroke: this.currentColor,
      strokeWidth: this.strokeWidth,
      selectable: false,
      evented: false,
      objectCaching: false
    };

    if (this.currentTool === 'circle') {
      this.activeShape = new fabric.Ellipse(Object.assign({}, props, {
        rx: 0, ry: 0, originX: 'center', originY: 'center'
      }));
    } else if (this.currentTool === 'rect') {
      this.activeShape = new fabric.Rect(Object.assign({}, props, {
        width: 0, height: 0
      }));
    } else if (this.currentTool === 'arrow') {
      this.activeShape = new fabric.Line(
        [pointer.x, pointer.y, pointer.x, pointer.y],
        {
          stroke: this.currentColor,
          strokeWidth: this.strokeWidth,
          selectable: false,
          evented: false,
          objectCaching: false
        }
      );
    }

    if (this.activeShape) {
      this.canvas.add(this.activeShape);
    }
  };

  ImageAnnotator.prototype._onMouseMove = function (o) {
    if (!this.isDrawingShape || !this.activeShape) return;

    var pointer = this.canvas.getPointer(o.e);
    var ox = this.shapeOrigin.x;
    var oy = this.shapeOrigin.y;

    if (this.currentTool === 'circle') {
      this.activeShape.set({
        rx: Math.abs(pointer.x - ox) / 2,
        ry: Math.abs(pointer.y - oy) / 2,
        left: (ox + pointer.x) / 2,
        top: (oy + pointer.y) / 2
      });
    } else if (this.currentTool === 'rect') {
      var left = Math.min(ox, pointer.x);
      var top = Math.min(oy, pointer.y);
      this.activeShape.set({
        left: left,
        top: top,
        width: Math.abs(pointer.x - ox),
        height: Math.abs(pointer.y - oy)
      });
    } else if (this.currentTool === 'arrow') {
      this.activeShape.set({ x2: pointer.x, y2: pointer.y });
    }

    this.canvas.renderAll();
  };

  ImageAnnotator.prototype._onMouseUp = function () {
    if (!this.isDrawingShape) return;
    this.isDrawingShape = false;

    if (!this.activeShape) return;

    // For arrow, replace the line with a proper arrow (line + triangle head)
    if (this.currentTool === 'arrow') {
      var line = this.activeShape;
      var x1 = line.x1, y1 = line.y1, x2 = line.x2, y2 = line.y2;
      var dx = x2 - x1, dy = y2 - y1;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len < 5) {
        this.canvas.remove(line);
        this.activeShape = null;
        return;
      }

      // Arrow head
      var angle = Math.atan2(dy, dx);
      var headLen = Math.max(12, this.strokeWidth * 4);
      var headAngle = Math.PI / 6;

      var headPoints = [
        { x: x2, y: y2 },
        { x: x2 - headLen * Math.cos(angle - headAngle), y: y2 - headLen * Math.sin(angle - headAngle) },
        { x: x2 - headLen * Math.cos(angle + headAngle), y: y2 - headLen * Math.sin(angle + headAngle) }
      ];

      var head = new fabric.Polygon(headPoints, {
        fill: this.currentColor,
        stroke: this.currentColor,
        strokeWidth: 1,
        selectable: false,
        evented: false
      });

      // Group them
      this.canvas.remove(line);
      var arrowLine = new fabric.Line([x1, y1, x2, y2], {
        stroke: this.currentColor,
        strokeWidth: this.strokeWidth,
        selectable: false,
        evented: false
      });

      var group = new fabric.Group([arrowLine, head], {
        selectable: true,
        evented: true,
        _annotationType: 'arrow'
      });
      this.canvas.add(group);
    }

    // Finalize shape
    if (this.activeShape && this.currentTool !== 'arrow') {
      this.activeShape.set({ selectable: true, evented: true });
    }

    this.activeShape = null;
    this.canvas.renderAll();
    this._saveHistory();
  };

  // ── Mouse Wheel Zoom ──────────────────────────────────
  ImageAnnotator.prototype._onMouseWheel = function (o) {
    var e = o.e;
    e.preventDefault();
    e.stopPropagation();

    var delta = e.deltaY;
    var pointer = this.canvas.getPointer(e);
    var point = new fabric.Point(pointer.x, pointer.y);

    if (delta < 0) {
      this._zoomAt(this.zoomLevel * 1.1, point);
    } else {
      this._zoomAt(this.zoomLevel / 1.1, point);
    }
  };

  // ── Add Text ──────────────────────────────────────────
  ImageAnnotator.prototype._addText = function (pointer) {
    var isAr = this.lang === 'ar';
    var input = prompt(isAr ? 'أدخل النص:' : 'Enter text:');
    if (!input) return;

    var text = new fabric.IText(input, {
      left: pointer.x,
      top: pointer.y,
      fill: this.currentColor,
      fontSize: Math.max(16, this.strokeWidth * 5),
      fontFamily: 'Inter, sans-serif',
      fontWeight: '600',
      selectable: true,
      evented: true,
      editable: true,
      _annotationType: 'text'
    });

    // Add a subtle background for readability
    var bgRect = new fabric.Rect({
      left: pointer.x - 4,
      top: pointer.y - 2,
      width: text.width + 8,
      height: text.height + 4,
      fill: 'rgba(0,0,0,0.5)',
      rx: 4,
      ry: 4,
      selectable: false,
      evented: false
    });

    this.canvas.add(bgRect);
    this.canvas.add(text);
    this.canvas.setActiveObject(text);
    this.canvas.renderAll();
    this._saveHistory();
  };

  // ── Zoom ──────────────────────────────────────────────
  ImageAnnotator.prototype.zoomIn = function () {
    this._zoomAt(this.zoomLevel * 1.25);
  };

  ImageAnnotator.prototype.zoomOut = function () {
    this._zoomAt(this.zoomLevel / 1.25);
  };

  ImageAnnotator.prototype.zoomToFit = function () {
    this.zoomLevel = 1;
    this.canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    this.canvas.setZoom(1);
    this.canvas.renderAll();
    this._updateZoomDisplay();
  };

  ImageAnnotator.prototype._zoomAt = function (newZoom, point) {
    newZoom = Math.min(Math.max(newZoom, 0.25), 4);
    this.zoomLevel = newZoom;

    if (point) {
      this.canvas.zoomToPoint(point, newZoom);
    } else {
      this.canvas.setZoom(newZoom);
    }
    this.canvas.renderAll();
    this._updateZoomDisplay();
  };

  ImageAnnotator.prototype._updateZoomDisplay = function () {
    this._els.zoomPct.textContent = Math.round(this.zoomLevel * 100) + '%';
  };

  // ── Undo / Redo ───────────────────────────────────────
  ImageAnnotator.prototype._saveHistory = function () {
    // Remove any redo states
    if (this.historyIdx < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyIdx + 1);
    }

    var state = JSON.stringify(this.canvas.toJSON(['_annotationType']));
    this.history.push(state);

    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }

    this.historyIdx = this.history.length - 1;
    this._updateHistoryBtns();
  };

  ImageAnnotator.prototype.undo = function () {
    if (this.historyIdx <= 0) return;
    this.historyIdx--;
    this._loadHistory();
  };

  ImageAnnotator.prototype.redo = function () {
    if (this.historyIdx >= this.history.length - 1) return;
    this.historyIdx++;
    this._loadHistory();
  };

  ImageAnnotator.prototype._loadHistory = function () {
    var self = this;
    var state = this.history[this.historyIdx];
    this.canvas.loadFromJSON(state, function () {
      self.canvas.renderAll();
      self._updateHistoryBtns();
    });
  };

  ImageAnnotator.prototype._updateHistoryBtns = function () {
    if (this._els.undoBtn) this._els.undoBtn.disabled = this.historyIdx <= 0;
    if (this._els.redoBtn) this._els.redoBtn.disabled = this.historyIdx >= this.history.length - 1;
  };

  // ── Delete ────────────────────────────────────────────
  ImageAnnotator.prototype.deleteSelected = function () {
    var objs = this.canvas.getActiveObjects();
    if (!objs.length) return;

    this.canvas.discardActiveObject();
    for (var i = 0; i < objs.length; i++) {
      this.canvas.remove(objs[i]);
    }
    this.canvas.renderAll();
    this._saveHistory();
  };

  ImageAnnotator.prototype._updateDeleteBtn = function () {
    if (this._els.delBtn) {
      this._els.delBtn.disabled = !this.canvas.getActiveObjects().length;
    }
  };

  // ── Clear All ─────────────────────────────────────────
  ImageAnnotator.prototype.clearAll = function () {
    var isAr = this.lang === 'ar';
    if (!confirm(isAr ? 'هل أنت متأكد؟ سيتم مسح جميع التعليقات.' : 'Clear all annotations? This cannot be undone.')) return;

    // Remove all objects but keep background image
    var objects = this.canvas.getObjects().slice();
    for (var i = 0; i < objects.length; i++) {
      this.canvas.remove(objects[i]);
    }
    this.canvas.renderAll();
    this._saveHistory();
  };

  // ── Save ──────────────────────────────────────────────
  ImageAnnotator.prototype.save = function () {
    if (this.saving) return;
    var self = this;
    this.saving = true;
    var isAr = this.lang === 'ar';
    this._setStatus(isAr ? 'جاري الحفظ...' : 'Saving...');

    var annotationState = this.canvas.toJSON(['_annotationType']);
    var objectCount = this.canvas.getObjects().length;

    // Generate a flattened image for the patient view
    var dataUrl = this.canvas.toDataURL({
      format: 'png',
      quality: 1,
      multiplier: 2
    });

    var payload = {
      imageId: this.imageId,
      caseId: this.caseId,
      annotationState: annotationState,
      annotatedImage: dataUrl,
      objectCount: objectCount
    };

    var headers = { 'Content-Type': 'application/json' };
    if (self.csrfToken) {
      headers['x-csrf-token'] = self.csrfToken;
    }

    fetch('/api/annotations/save', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      self.saving = false;
      if (data.ok) {
        self._setStatus(isAr ? 'تم الحفظ بنجاح' : 'Saved successfully');
        if (self.onSave) self.onSave(data);
      } else {
        self._setStatus((isAr ? 'خطأ: ' : 'Error: ') + (data.error || 'Unknown'));
      }
    })
    .catch(function (err) {
      self.saving = false;
      self._setStatus((isAr ? 'فشل الحفظ: ' : 'Save failed: ') + err.message);
    });
  };

  // ── Export Image ──────────────────────────────────────
  ImageAnnotator.prototype.exportImage = function () {
    var dataUrl = this.canvas.toDataURL({
      format: 'png',
      quality: 1,
      multiplier: 2
    });

    var link = document.createElement('a');
    link.href = dataUrl;
    link.download = 'annotated-' + (this.imageId || 'image') + '.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // ── Load Existing Annotation ──────────────────────────
  ImageAnnotator.prototype._loadAnnotationState = function (state) {
    var self = this;
    if (!state || !state.objects) return;

    this.canvas.loadFromJSON(state, function () {
      self.canvas.renderAll();
      self._saveHistory();
    });
  };

  // ── Resize ────────────────────────────────────────────
  ImageAnnotator.prototype._resizeCanvas = function () {
    var wrap = this._els.canvasWrap;
    if (!wrap) return;
    var w = wrap.clientWidth;
    var h = wrap.clientHeight;
    this.canvas.setDimensions({ width: w, height: h });
    this.canvas.renderAll();
  };

  // ── Status ────────────────────────────────────────────
  ImageAnnotator.prototype._setStatus = function (msg) {
    if (this._els.statusText) this._els.statusText.textContent = msg;
  };

  // ── Destroy ───────────────────────────────────────────
  ImageAnnotator.prototype.destroy = function () {
    if (this.canvas) {
      this.canvas.dispose();
      this.canvas = null;
    }
    this.containerEl.innerHTML = '';
  };

  // ── Helper ────────────────────────────────────────────
  function el(tag, className) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    return e;
  }

  // Export
  root.ImageAnnotator = ImageAnnotator;

})(window);
