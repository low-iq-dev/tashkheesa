// public/js/video-consultation.js
// Client-side Twilio Video integration for Tashkheesa video consultations.

(function () {
  'use strict';

  var TashkheesaVideoCall = {
    room: null,
    localTracks: [],
    screenTrack: null,
    timerInterval: null,
    timerSeconds: 0,
    audioMuted: false,
    videoMuted: false,
    screenSharing: false,
    config: null,

    // ── Initialize ──────────────────────────────────────────────
    init: function (config) {
      this.config = config;
      this._bindControls();
      this._fetchTokenAndConnect();
    },

    // ── Bind UI controls ────────────────────────────────────────
    _bindControls: function () {
      var self = this;

      var btnAudio = document.getElementById('btn-mute-audio');
      var btnVideo = document.getElementById('btn-mute-video');
      var btnScreen = document.getElementById('btn-screen-share');
      var btnEnd = document.getElementById('btn-end-call');

      if (btnAudio) btnAudio.addEventListener('click', function () { self._toggleAudio(); });
      if (btnVideo) btnVideo.addEventListener('click', function () { self._toggleVideo(); });
      if (btnScreen) btnScreen.addEventListener('click', function () { self._toggleScreenShare(); });
      if (btnEnd) btnEnd.addEventListener('click', function () { self._endCall(); });
    },

    // ── Fetch token and connect to Twilio room ─────────────────
    _fetchTokenAndConnect: function () {
      var self = this;
      self._setStatus('connecting', self.config.lang === 'ar' ? 'جارٍ الاتصال...' : 'Connecting...');

      fetch(self.config.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin'
      })
        .then(function (resp) {
          if (!resp.ok) throw new Error('Token request failed: ' + resp.status);
          return resp.json();
        })
        .then(function (data) {
          if (!data.ok || !data.token) {
            throw new Error(data.error || 'No token received');
          }
          self._connectToRoom(data.token, data.roomName);
        })
        .catch(function (err) {
          console.error('[video] Token fetch error:', err);
          self._showError(err.message || 'Failed to connect');
        });
    },

    // ── Connect to Twilio Video room ────────────────────────────
    _connectToRoom: function (token, roomName) {
      var self = this;

      if (typeof Twilio === 'undefined' || !Twilio.Video) {
        self._showError('Video SDK not loaded. Please refresh.');
        return;
      }

      Twilio.Video.connect(token, {
        name: roomName,
        audio: true,
        video: { width: 640, height: 480, frameRate: 24 },
        dominantSpeaker: true,
        networkQuality: { local: 1, remote: 1 }
      })
        .then(function (room) {
          self.room = room;
          self._setStatus('connected');
          self._hideStatusOverlay();
          self._startTimer();

          // Attach local tracks
          room.localParticipant.tracks.forEach(function (publication) {
            if (publication.track) {
              self._attachLocalTrack(publication.track);
              self.localTracks.push(publication.track);
            }
          });

          // Handle existing participants
          room.participants.forEach(function (participant) {
            self._handleParticipantConnected(participant);
          });

          // Handle new participants joining
          room.on('participantConnected', function (participant) {
            self._handleParticipantConnected(participant);
            self._hideWaiting();
          });

          // Handle participants leaving
          room.on('participantDisconnected', function (participant) {
            self._handleParticipantDisconnected(participant);
          });

          // Handle reconnection events
          room.on('reconnecting', function () {
            self._setStatus('reconnecting', self.config.lang === 'ar' ? 'إعادة الاتصال...' : 'Reconnecting...');
            self._showStatusOverlay();
          });

          room.on('reconnected', function () {
            self._setStatus('connected');
            self._hideStatusOverlay();
          });

          // Handle room disconnection
          room.on('disconnected', function (room, error) {
            if (error) {
              console.error('[video] Room disconnected with error:', error);
            }
            self._cleanup();
          });

          // If no remote participants yet, show waiting
          if (room.participants.size === 0) {
            self._showWaiting();
          } else {
            self._hideWaiting();
          }
        })
        .catch(function (err) {
          console.error('[video] Connect error:', err);
          var msg = err.message || 'Connection failed';
          if (msg.indexOf('Permission') !== -1 || msg.indexOf('NotAllowed') !== -1) {
            msg = self.config.lang === 'ar'
              ? 'يرجى السماح بالوصول إلى الكاميرا والميكروفون'
              : 'Please allow camera and microphone access';
          }
          self._showError(msg);
        });
    },

    // ── Handle participant connected ────────────────────────────
    _handleParticipantConnected: function (participant) {
      var self = this;

      participant.tracks.forEach(function (publication) {
        if (publication.isSubscribed && publication.track) {
          self._attachRemoteTrack(publication.track);
        }
      });

      participant.on('trackSubscribed', function (track) {
        self._attachRemoteTrack(track);
      });

      participant.on('trackUnsubscribed', function (track) {
        self._detachTrack(track);
      });
    },

    // ── Handle participant disconnected ─────────────────────────
    _handleParticipantDisconnected: function (participant) {
      var self = this;
      var remoteContainer = document.getElementById('remote-video');
      // Remove all their tracks
      participant.tracks.forEach(function (publication) {
        if (publication.track) {
          self._detachTrack(publication.track);
        }
      });
      self._showWaiting();
    },

    // ── Attach local video track ────────────────────────────────
    _attachLocalTrack: function (track) {
      if (track.kind === 'video') {
        var container = document.getElementById('local-video');
        if (container) {
          container.innerHTML = '';
          container.appendChild(track.attach());
        }
      }
    },

    // ── Attach remote track ─────────────────────────────────────
    _attachRemoteTrack: function (track) {
      var container = document.getElementById('remote-video');
      if (!container) return;

      // Hide waiting placeholder
      this._hideWaiting();

      var el = track.attach();
      el.id = 'remote-track-' + track.sid;
      container.appendChild(el);
    },

    // ── Detach track ────────────────────────────────────────────
    _detachTrack: function (track) {
      var elements = track.detach();
      elements.forEach(function (el) { el.remove(); });
    },

    // ── Toggle audio mute ───────────────────────────────────────
    _toggleAudio: function () {
      if (!this.room) return;
      this.audioMuted = !this.audioMuted;

      var btn = document.getElementById('btn-mute-audio');
      var iconOn = document.getElementById('icon-mic-on');
      var iconOff = document.getElementById('icon-mic-off');

      this.room.localParticipant.audioTracks.forEach(function (publication) {
        if (publication.track) {
          if (this.audioMuted) {
            publication.track.disable();
          } else {
            publication.track.enable();
          }
        }
      }.bind(this));

      if (btn) btn.classList.toggle('muted', this.audioMuted);
      if (iconOn) iconOn.style.display = this.audioMuted ? 'none' : 'block';
      if (iconOff) iconOff.style.display = this.audioMuted ? 'block' : 'none';
    },

    // ── Toggle video mute ───────────────────────────────────────
    _toggleVideo: function () {
      if (!this.room) return;
      this.videoMuted = !this.videoMuted;

      var btn = document.getElementById('btn-mute-video');
      var iconOn = document.getElementById('icon-video-on');
      var iconOff = document.getElementById('icon-video-off');

      this.room.localParticipant.videoTracks.forEach(function (publication) {
        if (publication.track) {
          if (this.videoMuted) {
            publication.track.disable();
          } else {
            publication.track.enable();
          }
        }
      }.bind(this));

      if (btn) btn.classList.toggle('muted', this.videoMuted);
      if (iconOn) iconOn.style.display = this.videoMuted ? 'none' : 'block';
      if (iconOff) iconOff.style.display = this.videoMuted ? 'block' : 'none';
    },

    // ── Toggle screen sharing ───────────────────────────────────
    _toggleScreenShare: function () {
      var self = this;
      if (!self.room) return;

      if (self.screenSharing && self.screenTrack) {
        // Stop sharing
        self.room.localParticipant.unpublishTrack(self.screenTrack);
        self.screenTrack.stop();
        self.screenTrack = null;
        self.screenSharing = false;
        var btn = document.getElementById('btn-screen-share');
        if (btn) btn.classList.remove('active');
        return;
      }

      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        console.warn('[video] Screen sharing not supported');
        return;
      }

      navigator.mediaDevices.getDisplayMedia({ video: true })
        .then(function (stream) {
          var screenTrack = new Twilio.Video.LocalVideoTrack(stream.getTracks()[0], { name: 'screen' });
          self.room.localParticipant.publishTrack(screenTrack);
          self.screenTrack = screenTrack;
          self.screenSharing = true;

          var btn = document.getElementById('btn-screen-share');
          if (btn) btn.classList.add('active');

          // Handle browser "Stop sharing" button
          screenTrack.mediaStreamTrack.onended = function () {
            self._toggleScreenShare();
          };
        })
        .catch(function (err) {
          console.warn('[video] Screen share cancelled or failed:', err.message);
        });
    },

    // ── End call ────────────────────────────────────────────────
    _endCall: function () {
      var self = this;
      var msg = self.config.lang === 'ar' ? 'هل تريد إنهاء المكالمة؟' : 'End this call?';
      if (!confirm(msg)) return;

      self._setStatus('ending', self.config.lang === 'ar' ? 'جارٍ إنهاء المكالمة...' : 'Ending call...');
      self._showStatusOverlay();

      // Disconnect from Twilio room
      if (self.room) {
        self.room.disconnect();
      }

      // Notify server
      fetch(self.config.endEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin'
      })
        .then(function (resp) { return resp.json(); })
        .then(function (data) {
          window.location.href = self.config.redirectAfterEnd;
        })
        .catch(function () {
          window.location.href = self.config.redirectAfterEnd;
        });
    },

    // ── Timer ───────────────────────────────────────────────────
    _startTimer: function () {
      var self = this;
      var timerEl = document.getElementById('vc-timer');
      if (!timerEl) return;

      self.timerSeconds = 0;
      self.timerInterval = setInterval(function () {
        self.timerSeconds++;
        var h = Math.floor(self.timerSeconds / 3600);
        var m = Math.floor((self.timerSeconds % 3600) / 60);
        var s = self.timerSeconds % 60;

        var display = '';
        if (h > 0) display = self._pad(h) + ':';
        display += self._pad(m) + ':' + self._pad(s);
        timerEl.textContent = display;
      }, 1000);
    },

    _pad: function (n) {
      return n < 10 ? '0' + n : String(n);
    },

    // ── Status helpers ──────────────────────────────────────────
    _setStatus: function (status, message) {
      var msgEl = document.getElementById('vc-status-msg');
      if (msgEl && message) msgEl.textContent = message;
    },

    _showStatusOverlay: function () {
      var overlay = document.getElementById('vc-status');
      if (overlay) overlay.classList.remove('hidden');
    },

    _hideStatusOverlay: function () {
      var overlay = document.getElementById('vc-status');
      if (overlay) overlay.classList.add('hidden');
    },

    _showWaiting: function () {
      var el = document.getElementById('vc-waiting');
      if (el) el.style.display = '';
    },

    _hideWaiting: function () {
      var el = document.getElementById('vc-waiting');
      if (el) el.style.display = 'none';
    },

    _showError: function (message) {
      var overlay = document.getElementById('vc-error');
      var msgEl = document.getElementById('vc-error-msg');
      if (overlay) overlay.style.display = '';
      if (msgEl && message) msgEl.textContent = message;

      // Hide connecting overlay
      this._hideStatusOverlay();
    },

    // ── Cleanup ─────────────────────────────────────────────────
    _cleanup: function () {
      if (this.timerInterval) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
      }

      this.localTracks.forEach(function (track) {
        track.stop();
        var elements = track.detach();
        elements.forEach(function (el) { el.remove(); });
      });
      this.localTracks = [];

      if (this.screenTrack) {
        this.screenTrack.stop();
        this.screenTrack = null;
      }

      this.room = null;
    }
  };

  // Expose globally
  window.TashkheesaVideoCall = TashkheesaVideoCall;
})();
