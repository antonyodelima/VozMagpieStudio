/*
 * Cartesia Sonic TTS integration for VozForge Studio.
 *
 * Loaded with `defer`, after the inline app script has run, so all inline
 * top-level bindings (db, VOICES, currentAudioUrl, toast, pcmToWav, ...) are
 * reachable here as bare identifiers (classic-script global scope).
 *
 * Behavior:
 *  - Reads /api/config once to know if the server has CARTESIA_API_KEY.
 *  - Intercepts clicks on #generateBtn (capture phase) only when the selected
 *    voice is eligible: catalog voices (matched against the Cartesia catalog)
 *    or cloned profiles that already have a `cartesiaVoiceId`.
 *  - Synthesizes blocks via /api/cartesia/tts (PCM s16le 24 kHz), reuses the
 *    app's own WAV/cover/history pipeline, and mirrors the native success UI.
 *  - Any failure falls back to the inline Gemini flow by calling generate().
 *  - Best-effort remote cloning: after a profile is saved locally, uploads the
 *    sample to /api/cartesia/clone and stores the returned voice id.
 */
(function () {
  'use strict';

  var available = false;
  var vaultRefreshBound = false;

  // Reage ao painel Admin: chave Cartesia/Gemini adicionada ao Cofre de Segredos.
  if (!vaultRefreshBound) {
    vaultRefreshBound = true;
    window.addEventListener('vault-changed', function () { refreshConfig(); });
  }
  var source = null;
  var geminiAvailable = false;

  function refreshConfig() {
    try {
      return fetch('/api/config')
        .then(function (r) { return r.json(); })
        .then(function (c) {
          available = Boolean(c && c.hasCartesiaKey);
          source = c && c.cartesiaSource ? c.cartesiaSource : null;
          geminiAvailable = Boolean(c && (c.hasServerKey || safe(function () { return db.keys && db.keys.length > 0; }, false)));
          renderEngineStatus();
          return c;
        })
        .catch(function () { available = false; return null; });
    } catch (e) { available = false; return Promise.resolve(null); }
  }

  function initConfig() { refreshConfig(); }

  // ---- Motor de Voz: preferência do usuário (cartesia | gemini | auto) ----
  function getEnginePref() {
    var p = safe(function () { return db && db.settings && db.settings.ttsEngine; }, null);
    if (!p) { try { p = localStorage.getItem('vozforge.ttsEngine'); } catch (e) { p = null; } }
    return (p === 'cartesia' || p === 'gemini' || p === 'auto') ? p : 'auto';
  }

  function setEnginePref(pref) {
    safe(function () { db.settings.ttsEngine = pref; saveDb(); });
    try { localStorage.setItem('vozforge.ttsEngine', pref); } catch (e) { /* noop */ }
    renderEngineSelector();
    renderEngineStatus();
    updateModelPill();
    refreshConfig();
    if (typeof toast === 'function') {
      toast(pref === 'cartesia' ? '⚡ Motor Cartesia Sonic selecionado'
        : pref === 'gemini' ? '✦ Motor Gemini TTS selecionado'
        : '🔄 Automático: Cartesia → Gemini');
    }
  }

  function renderEngineSelector() {
    var pref = getEnginePref();
    safe(function () {
      document.querySelectorAll('#engineChips [data-engine]').forEach(function (b) {
        b.classList.toggle('active', b.dataset.engine === pref);
      });
    });
  }

  function renderEngineStatus() {
    var pill = byId('engineStatusPill');
    var hint = byId('engineHint');
    var cs = available ? '\u26a1 ativa' : 'sem chave';
    var gm = geminiAvailable ? '\u2726 ativa' : 'sem chave';
    if (pill) {
      pill.textContent = 'Cartesia: ' + cs + ' \u00b7 Gemini: ' + gm;
      pill.className = 'pill' + (available || geminiAvailable ? ' ok' : '');
    }
    if (hint) {
      hint.textContent = available
        ? 'Cartesia Sonic ativa (' + (source === 'environment' ? 'vari\u00e1vel de ambiente' : 'cofre do servidor') + ') \u2014 lat\u00eancia ultrabaixa. Perfis clonados usam o clone remoto quando dispon\u00edvel.'
        : 'Sem chave Cartesia no servidor (CARTESIA_API_KEY). O motor Gemini continua dispon\u00edvel' + (geminiAvailable ? ' e ativo.' : ' assim que uma chave v\u00e1lida for configurada.');
    }
  }

  function updateModelPill() {
    var pref = getEnginePref();
    var el = byId('modelPill');
    if (!el) return;
    el.textContent = pref === 'cartesia' ? '\u26a1 Cartesia Sonic'
      : pref === 'gemini' ? '\u2726 Gemini TTS Preview'
      : '\u26a1\u2726 Auto (Cartesia \u2192 Gemini)';
  }

  function injectEngineUI() {
    if (byId('engineSelectorCard')) return;
    var speedCard = document.querySelector('.studio-screen .speed-card');
    if (!speedCard || !speedCard.parentNode) return;

    // Remapeia as linhas do grid desktop (o app usa grid-row fixos por seletor).
    var style = document.createElement('style');
    style.textContent =
      '.studio-screen>.stack>#engineSelectorCard{grid-column:2;grid-row:6}' +
      '.studio-screen>.stack>.studio-actions{grid-row:7}' +
      '.studio-screen>.stack>#generationStatus{grid-row:8}' +
      '.studio-screen>.stack>#playerBox{grid-row:9}' +
      '.studio-screen>.stack>#studioGenerationsSection{grid-row:10}' +
      '.studio-screen>.stack>.notice.warn{grid-row:11}';
    document.head.appendChild(style);

    var card = document.createElement('div');
    card.id = 'engineSelectorCard';
    card.className = 'card';
    card.style.cssText = 'background:#0c1427;border:1px solid var(--line);padding:14px;border-radius:14px;margin:0';
    card.innerHTML =
      '<div class="row" style="margin-bottom:10px">' +
        '<label style="font-size:13px;font-weight:700;color:#cdd6eb">\ud83c\udf9a\ufe0f Motor de Voz</label>' +
        '<span class="pill" id="engineStatusPill" style="max-width:62%">verificando\u2026</span>' +
      '</div>' +
      '<div class="chip-bar" id="engineChips" style="padding:0;gap:6px;flex-wrap:wrap;overflow:visible">' +
        '<button type="button" class="chip" data-engine="cartesia" title="Lat\u00eancia ultrabaixa com Sonic-3 (requer chave Cartesia no servidor)">\u26a1 Cartesia Sonic</button>' +
        '<button type="button" class="chip" data-engine="gemini" title="Vozes Gemini TTS e clonagem local">\u2726 Gemini TTS</button>' +
        '<button type="button" class="chip" data-engine="auto" title="Usa Cartesia quando poss\u00edvel e cai para o Gemini automaticamente">\ud83d\udd04 Autom\u00e1tico</button>' +
      '</div>' +
      '<div class="hint" id="engineHint" style="margin-top:8px"></div>';

    speedCard.parentNode.insertBefore(card, speedCard.nextSibling);

    card.querySelectorAll('[data-engine]').forEach(function (chipBtn) {
      chipBtn.addEventListener('click', function () { setEnginePref(chipBtn.dataset.engine); });
    });

    renderEngineSelector();
    renderEngineStatus();
    updateModelPill();
  }

  function byId(id) { return document.getElementById(id); }

  function safe(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }

  function setStatusHtml(html, className) {
    var box = byId('generationStatus');
    if (!box) return;
    box.className = className || 'notice info';
    box.classList.remove('hidden');
    box.innerHTML = html;
  }

  function setProgress(msg, pct) {
    setStatusHtml(
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
        '<span>' + msg + '</span><b>' + pct + '%</b></div>' +
        '<div class="meter"><i style="width:' + pct + '%"></i></div>',
      'notice info'
    );
  }

  function fmtDuration(sec) {
    var m = Math.floor(sec / 60);
    var s = Math.round(sec % 60);
    return m > 0 ? m + 'min ' + String(s).padStart(2, '0') + 's' : s + 's';
  }

  function computeBlocks(text) {
    var autoSplit = safe(function () { return byId('autoSplitToggle').checked; }, true);
    var maxChunk = safe(function () { return Number(byId('chunkSizeSelect').value) || 2000; }, 2000);
    if (autoSplit && typeof splitTextIntoBlocks === 'function') {
      var blocks = splitTextIntoBlocks(text, maxChunk);
      if (blocks && blocks.length) return blocks;
    }
    return [text];
  }

  function selectedCatalogVoice() {
    return safe(function () {
      if (!db || !db.selectedVoice || String(db.selectedVoice).indexOf('clone:') === 0) return null;
      // Só intercepta vozes de catálogo marcadas como ⚡ Cartesia;
      // vozes Gemini seguem o fluxo inline original.
      var cat = (typeof VOICES !== 'undefined') && VOICES.find
        ? VOICES.find(function (v) { return v[0] === db.selectedVoice && v[2] === 'cartesia'; })
        : null;
      if (!cat) return null;
      return { name: cat[0], style: cat[1], displayName: cat[0], isClone: false, voiceId: cat[3] || null };
    }, null);
  }

  function selectedCloneWithCartesiaId() {
    return safe(function () {
      if (!db || !db.selectedVoice || String(db.selectedVoice).indexOf('clone:') !== 0) return null;
      var pid = db.selectedVoice.slice(6);
      var profile = (db.profiles || []).find(function (p) { return p.id === pid; });
      if (!profile || !profile.cartesiaVoiceId) return null;
      return {
        voiceId: profile.cartesiaVoiceId,
        name: profile.name,
        displayName: '\uD83E\uDD9C ' + profile.name,
        style: 'Clone Ultra-Realista',
        isClone: true
      };
    }, null);
  }

  function fetchCartesiaVoiceId(catalogName) {
    return fetch('/api/cartesia/voices')
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          throw new Error((res.data && res.data.error && res.data.error.message) || 'Cartesia indisponível');
        }
        var voices = (res.data && res.data.voices) || [];
        var lname = String(catalogName).toLowerCase();
        var match = null;
        for (var i = 0; i < voices.length && !match; i++) {
          var n = voices[i] && voices[i].name ? String(voices[i].name).toLowerCase() : '';
          if (n === lname) match = voices[i];
        }
        for (var j = 0; j < voices.length && !match; j++) {
          var n2 = voices[j] && voices[j].name ? String(voices[j].name).toLowerCase() : '';
          if (n2 && (n2.indexOf(lname) !== -1 || lname.indexOf(n2.split(' ')[0]) === 0)) match = voices[j];
        }
        if (!match || !match.id) throw new Error('Voz "' + catalogName + '" não disponível na Cartesia.');
        return match.id;
      });
  }

  function synthesizeBlock(transcript, voiceId) {
    return fetch('/api/cartesia/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: transcript, voice_id: voiceId })
    })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error((res.data && res.data.error && res.data.error.message) || 'Falha na síntese Cartesia');
        if (!res.data || !res.data.audio_base64) throw new Error('Bloco Cartesia sem áudio.');
        var pcm = extractPcmSamples(res.data.audio_base64);
        if (!pcm || !pcm.length) throw new Error('Áudio Cartesia vazio.');
        return pcm;
      });
  }

  function runCartesiaGeneration(plan) {
    var text = byId('textInput').value.trim();
    var blocks = computeBlocks(text);
    var speed = safe(function () { return currentPlaybackSpeed || 1.0; }, 1.0);
    var btn = byId('generateBtn');
    var voiceIdPromise = (plan.isClone || plan.voiceId)
      ? Promise.resolve(plan.voiceId)
      : fetchCartesiaVoiceId(plan.name);

    if (btn) { btn.disabled = true; btn.textContent = 'Gerando…'; }

    return voiceIdPromise
      .then(function (voiceId) {
        var pcmChunks = [];
        var chain = Promise.resolve();
        blocks.forEach(function (blockText, idx) {
          chain = chain.then(function () {
            setProgress('Sintetizando bloco ' + (idx + 1) + ' de ' + blocks.length + ' com Cartesia Sonic…', Math.max(5, Math.round((idx / blocks.length) * 85)));
            return synthesizeBlock(blockText, voiceId).then(function (pcm) {
              pcmChunks.push(pcm);
              if (idx < blocks.length - 1) return new Promise(function (r) { setTimeout(r, 250); });
            });
          });
        });
        return chain.then(function () {
          setProgress('Concatenando ' + blocks.length + ' bloco(s) no player final…', 95);
          var finalPcm = pcmChunks.length > 1
            ? concatenatePcm(pcmChunks, 220, 24000)
            : pcmChunks[0];
          var wavBlob = pcmToWav(finalPcm, 24000, 1, 16);
          var audioUrl = URL.createObjectURL(wavBlob);

          safe(function () { if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl); });
          safe(function () { currentFinalPcm = finalPcm; });
          safe(function () { currentWavBlob = wavBlob; });
          safe(function () { currentMp3Blob = null; });
          safe(function () { currentAudioUrl = audioUrl; });

          var player = byId('audioPlayer');
          if (player) { player.src = audioUrl; player.playbackRate = speed; }

          var projectTitle = text.slice(0, 45).trim() + (text.length > 45 ? '…' : '');
          var cover = typeof createProceduralCover === 'function'
            ? createProceduralCover({ title: projectTitle, text: text, voice: plan.displayName, voiceStyle: plan.style, themeId: activeCoverTheme })
            : '';

          var genItem = {
            id: safe(function () { return crypto.randomUUID(); }, 'cs_' + Date.now()),
            title: projectTitle,
            text: text,
            voice: plan.displayName,
            voiceName: plan.name,
            voiceStyle: plan.style,
            isClone: plan.isClone,
            profileId: plan.isClone ? plan.profileId || null : null,
            speed: speed,
            chars: text.length,
            blocksCount: blocks.length,
            blocks: blocks,
            cover: cover,
            theme: safe(function () { return activeCoverTheme; }, 'cyberpunk'),
            at: new Date().toISOString(),
            provider: 'cartesia'
          };
          safe(function () { db.generations.unshift(genItem); if (db.generations.length > 50) db.generations.pop(); saveDb(); });

          var coverImg = byId('playerCoverImg');
          if (coverImg && cover) coverImg.src = cover;
          var titleEl = byId('playerProjectTitle');
          if (titleEl) titleEl.textContent = projectTitle;
          var playerBox = byId('playerBox');
          if (playerBox) playerBox.classList.remove('hidden');

          var durationSec = Math.round((finalPcm.length / (24000 * 2)) / speed);
          var durationFmt = Math.floor(durationSec / 60) + ':' + String(durationSec % 60).padStart(2, '0');
          var meta = byId('audioMeta');
          if (meta) {
            meta.textContent = plan.displayName + ' (' + plan.style + ')' +
              (speed !== 1.0 ? ' · ⚡ ' + speed + 'x' : '') +
              ' · ' + text.length + ' caracteres' +
              (blocks.length > 1 ? ' · ' + blocks.length + ' blocos' : '') +
              ' · ~' + durationFmt + ' · ⚡ Cartesia Sonic PCM 24 kHz';
          }

          safe(function () { renderPlayerBlocks(blocks); });
          safe(function () { activeCoverGenId = genItem.id; });
          safe(function () { activeCoverDataUrl = cover; });
          safe(function () { currentProjectMeta = { title: projectTitle, text: text, voice: plan.displayName, voiceStyle: plan.style }; });
          safe(function () { renderGenerations(); });
          safe(function () { renderHomeRecent(); });
          safe(function () { updateStats(); });
          safe(function () { event('cartesia_generation', plan.displayName + ' (' + blocks.length + ' blocos, ' + speed + 'x)'); });
          safe(function () { haptic(30); });

          setProgress('✓ Narração Cartesia Sonic com ' + plan.displayName + ' finalizada (' + blocks.length + ' bloco' + (blocks.length > 1 ? 's' : '') + ', ~' + durationFmt + ')!', 100);
          if (typeof toast === 'function') toast('⚡ Narração Cartesia Sonic (' + plan.name + ') concluída!');
        });
      })
      .catch(function (err) {
        var msg = (err && err.message) || 'erro desconhecido';
        var box = byId('generationStatus');
        if (box) {
          box.className = 'notice warn';
          box.classList.remove('hidden');
          box.textContent = 'Cartesia indisponível (' + msg + '). Usando Gemini TTS…';
        }
        if (typeof toast === 'function') toast('Cartesia falhou — gerando com Gemini.');
        if (typeof generate === 'function') {
          setTimeout(function () { safe(function () { generate(); }); }, 350);
        }
      })
      .then(function () {
        if (btn) { btn.disabled = false; btn.textContent = '✨ Gerar áudio'; }
      });
  }

  // Intercept clicks on the generate button (capture phase runs before the
  // inline bubble handler, so we can fully take over when eligible).
  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.closest) return;
    var btn = target.closest('#generateBtn');
    if (!btn || btn.disabled) return;

    var pref = getEnginePref();
    if (pref === 'gemini') return; // usu\u00e1rio fixou Gemini: fluxo inline intacto
    if (!available) {
      if (pref === 'cartesia' && typeof toast === 'function') {
        toast('\u26a1 Cartesia sem chave no servidor \u2014 gerando com Gemini.');
      }
      return;
    }

    var text = safe(function () { return byId('textInput').value.trim(); }, '');
    if (!text) return; // let inline flow show its own validation toast

    var clonePlan = selectedCloneWithCartesiaId();
    if (clonePlan) {
      e.preventDefault();
      e.stopImmediatePropagation();
      runCartesiaGeneration({
        isClone: true,
        voiceId: clonePlan.voiceId,
        profileId: clonePlan.id,
        name: clonePlan.name,
        displayName: clonePlan.displayName,
        style: clonePlan.style
      });
      return;
    }

    var cat = selectedCatalogVoice();
    if (cat) {
      e.preventDefault();
      e.stopImmediatePropagation();
      runCartesiaGeneration({
        isClone: false,
        name: cat.name,
        displayName: cat.displayName,
        style: cat.style
      });
      return;
    }
    if (pref === 'cartesia' && typeof toast === 'function') {
      toast('Voz atual n\u00e3o dispon\u00edvel na Cartesia \u2014 gerando com Gemini.');
    }
    // Otherwise: fall through to the inline Gemini flow untouched.
  }, true);

  // Best-effort remote cloning: watch for a newly saved profile and upload its
  // sample to /api/cartesia/clone, storing the returned Cartesia voice id.
  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.closest) return;
    if (!target.closest('#saveProfileBtn')) return;
    if (!available) return;
    var before = safe(function () { return (db.profiles || []).map(function (p) { return p.id; }); }, []);
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var newProfile = safe(function () {
        return (db.profiles || []).find(function (p) { return before.indexOf(p.id) === -1; });
      }, null);
      if (newProfile || tries > 10) {
        clearInterval(timer);
        if (!newProfile || !newProfile.data) return;
        try {
          var b64 = String(newProfile.data).split(',')[1] || '';
          var bin = atob(b64);
          var bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          var mime = 'audio/webm';
          var semis = String(newProfile.data).slice(0, 80).split(';');
          for (var s = 0; s < semis.length; s++) {
            if (semis[s].indexOf('data:') === 0) mime = semis[s].slice(5).trim() || mime;
          }
          var blob = new Blob([bytes], { type: mime });
          fetch('/api/cartesia/clone', {
            method: 'POST',
            headers: {
              'Content-Type': mime,
              'Content-Length': String(blob.size),
              'x-voice-name': 'VozForge · ' + String(newProfile.name || 'Voz clonada').slice(0, 60),
              'x-voice-lang': 'pt',
              'x-voice-desc': 'Clone vocal criado no VozForge Studio a partir de amostra do usuário.'
            },
            body: blob
          })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (res) {
              if (res.ok && res.data && res.data.id) {
                safe(function () {
                  newProfile.cartesiaVoiceId = res.data.id;
                  saveDb();
                });
                if (typeof toast === 'function') toast('🧬 Clone remoto Cartesia criado! Fidelidade ainda maior.');
              }
            })
            .catch(function () { /* silent best-effort */ });
        } catch (err) { /* silent best-effort */ }
      }
    }, 700);
  }, true);

  // ---- Cofre de Segredos (Backend) ----
  // A UI nativa do painel Admin (index.html) já possui o seletor de provedor
  // Gemini/Cartesia; a injeção dinâmica legada foi removida para evitar campos
  // duplicados. Aqui fica apenas o listener de reação ao painel Admin.

  function boot() {
    injectEngineUI();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
