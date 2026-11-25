(function () {
  "use strict";

  var DICTIONARY_URL = "dictionary.json";
  var IMAGE_EXT = /\.(gif|png|jpe?g|webp|svg)$/i;
  var IMAGE_DURATION_MS = 2500;
  var VIDEO_TIMEOUT_MS = 20000;
  var LLM_TIMEOUT_MS = 20000;

  var micBtn = document.getElementById("micBtn");
  var statusEl = document.getElementById("status");
  var errorBox = document.getElementById("errorBox");
  var textInput = document.getElementById("textInput");
  var sendBtn = document.getElementById("sendBtn");
  var useLlmEl = document.getElementById("useLlm");
  var transcriptEl = document.getElementById("transcript");
  var glossEl = document.getElementById("glossOutput");
  var playerEl = document.querySelector(".player");
  var video = document.getElementById("signVideo");
  var currentWordEl = document.getElementById("currentWord");
  var sequenceEl = document.getElementById("sequence");
  var missingEl = document.getElementById("missingWords");
  var replayBtn = document.getElementById("replayBtn");
  var clearBtn = document.getElementById("clearBtn");
  var speedSelect = document.getElementById("speedSelect");

  var imageEl = document.createElement("img");
  imageEl.alt = "إشارة";
  imageEl.style.cssText = "display:none;width:100%;height:100%;object-fit:contain;background:#0f1a17;";
  playerEl.appendChild(imageEl);

  var signs = [];
  var signIndex = new Map();
  var recognition = null;
  var isListening = false;
  var busy = false;
  var lastItems = [];
  var chipEls = [];
  var runId = 0;
  var cancelCurrent = null;
  var speed = 1;

  var finalText = "";
  var interimText = "";
  var hadError = false;

  /* ---------- أدوات مساعدة للواجهة ---------- */

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function clearError() {
    errorBox.textContent = "";
    errorBox.hidden = true;
  }

  function setControlsDisabled(disabled) {
    sendBtn.disabled = disabled;
    micBtn.disabled = disabled || !recognition;
  }

  function updateMicButton() {
    if (isListening) {
      micBtn.classList.add("recording");
      micBtn.textContent = "⏹ إيقاف التسجيل";
    } else {
      micBtn.classList.remove("recording");
      micBtn.textContent = "🎤 ابدأ التسجيل";
    }
  }

  function showMedia(kind) {
    if (kind === "video") {
      playerEl.classList.add("has-video");
      video.style.display = "block";
      imageEl.style.display = "none";
    } else if (kind === "image") {
      playerEl.classList.add("has-video");
      video.style.display = "none";
      imageEl.style.display = "block";
    } else {
      playerEl.classList.remove("has-video");
      video.style.display = "";
      imageEl.style.display = "none";
    }
  }

  /* ---------- معالجة النص العربي ---------- */

  function normalizeArabic(text) {
    return String(text || "")
      .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
      .replace(/\u0640/g, "")
      .replace(/[أإآٱ]/g, "ا")
      .replace(/ى/g, "ي")
      .replace(/ة/g, "ه")
      .replace(/[^\u0621-\u064A\u0660-\u0669a-zA-Z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function stripAl(word) {
    if (word.length > 3 && word.indexOf("ال") === 0) {
      return word.slice(2);
    }
    return word;
  }

  function splitWords(text) {
    return String(text || "")
      .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(function (w) {
        return w.length > 0;
      });
  }

  /* ---------- القاموس ---------- */

  function buildIndex() {
    signIndex.clear();
    signs.forEach(function (sign) {
      var keys = [sign.word].concat(Array.isArray(sign.aliases) ? sign.aliases : []);
      keys.forEach(function (key) {
        var normalized = normalizeArabic(key);
        if (normalized && !signIndex.has(normalized)) {
          signIndex.set(normalized, sign);
        }
      });
    });
  }

  function findSign(token) {
    var normalized = normalizeArabic(token);
    if (!normalized) {
      return null;
    }
    if (signIndex.has(normalized)) {
      return signIndex.get(normalized);
    }
    var stripped = stripAl(normalized);
    if (stripped !== normalized && signIndex.has(stripped)) {
      return signIndex.get(stripped);
    }
    return null;
  }

  function greedyMatch(words) {
    var result = [];
    var i = 0;
    while (i < words.length) {
      if (i + 1 < words.length) {
        var pair = words[i] + " " + words[i + 1];
        var pairSign = findSign(pair);
        if (pairSign) {
          result.push({ token: pair, sign: pairSign });
          i += 2;
          continue;
        }
      }
      result.push({ token: words[i], sign: findSign(words[i]) });
      i += 1;
    }
    return result;
  }

  function buildItems(glossList) {
    var items = [];
    glossList.forEach(function (entry) {
      var whole = findSign(entry);
      if (whole) {
        items.push({ token: entry, sign: whole });
        return;
      }
      var words = splitWords(entry);
      if (words.length > 1) {
        items = items.concat(greedyMatch(words));
      } else if (words.length === 1) {
        items.push({ token: words[0], sign: null });
      }
    });
    return items;
  }

  async function loadDictionary() {
    var response;
    try {
      response = await fetch(DICTIONARY_URL, { cache: "no-store" });
    } catch (err) {
      throw new Error("مش قادر أحمّل dictionary.json. شغّل الصفحة بـ Live Server (Go Live) مش بفتح الملف مباشرة.");
    }
    if (!response.ok) {
      throw new Error("مش لاقي dictionary.json (HTTP " + response.status + "). اتأكد إنه جنب index.html وبنفس الاسم.");
    }
    var data;
    try {
      data = await response.json();
    } catch (err) {
      throw new Error("ملف dictionary.json فيه خطأ في الصياغة (غالباً فاصلة ناقصة أو زيادة). افتحه في VS Code وشوف الخطوط الحمراء.");
    }
    if (!data || !Array.isArray(data.signs) || data.signs.length === 0) {
      throw new Error("dictionary.json لازم يحتوي على مصفوفة اسمها signs وفيها إشارة واحدة على الأقل.");
    }
    signs = data.signs.filter(function (s) {
      return s && s.word && s.file;
    });
    buildIndex();
  }

  /* ---------- Gemini ---------- */

  function describeGeminiError(status, data) {
    var apiMessage = data && data.error && data.error.message ? data.error.message : "";
    if (status === 400 && /api key/i.test(apiMessage)) {
      return "مفتاح Gemini غير صحيح. راجع GEMINI_API_KEY في config.js.";
    }
    if (status === 400) {
      return "Gemini رفض الطلب (400): " + apiMessage;
    }
    if (status === 401 || status === 403) {
      return "المفتاح مش مسموح له باستخدام الموديل ده (" + status + "). تأكد من المفتاح ومن إن الـ API مفعّل.";
    }
    if (status === 404) {
      return "اسم الموديل غلط أو مش متاح (404). راجع GEMINI_MODEL في config.js.";
    }
    if (status === 429) {
      return "عديت الحد المجاني لطلبات Gemini (429). استنى دقيقة وجرّب تاني.";
    }
    if (status >= 500) {
      return "سيرفر Gemini مشغول دلوقتي (" + status + "). جرّب بعد شوية.";
    }
    return "خطأ من Gemini (" + status + "): " + apiMessage;
  }

  function parseGlossJson(raw) {
    var cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    var parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      throw new Error("رد Gemini مش JSON صالح.");
    }
    if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.gloss)) {
      parsed = parsed.gloss;
    }
    if (!Array.isArray(parsed)) {
      throw new Error("رد Gemini مش مصفوفة كلمات.");
    }
    var list = parsed
      .filter(function (w) {
        return typeof w === "string" && w.trim().length > 0;
      })
      .map(function (w) {
        return w.trim();
      });
    if (list.length === 0) {
      throw new Error("Gemini رجّع قائمة فاضية.");
    }
    return list;
  }

  async function getGlossFromGemini(sentence) {
    if (typeof CONFIG === "undefined") {
      throw new Error("ملف config.js مش متحمّل.");
    }
    var key = String(CONFIG.GEMINI_API_KEY || "").trim();
    if (!key || key.indexOf("PUT_YOUR") !== -1) {
      throw new Error("مفتاح Gemini مش متحط في config.js.");
    }

    var url = CONFIG.GEMINI_ENDPOINT + CONFIG.GEMINI_MODEL + ":generateContent";
    var vocabulary = signs
      .map(function (s) {
        return s.word;
      })
      .join("، ");

    var systemText =
      "You convert Modern Standard Arabic or Egyptian Arabic sentences into Arabic Sign Language gloss.\n" +
      "Rules:\n" +
      "1. Return ONLY a JSON array of Arabic strings, nothing else.\n" +
      "2. Keep only meaningful content words: nouns, verbs, adjectives, pronouns, numbers, question words.\n" +
      "3. Remove articles (ال), prepositions, conjunctions and auxiliary words that sign language does not use.\n" +
      "4. Convert every verb to its base present-tense third-person masculine singular form (examples: أكلت -> يأكل, بحب -> يحب).\n" +
      "5. Order the words the way sign language does: subject, then object, then verb.\n" +
      "6. If a word has the same meaning as a word in the provided dictionary list, use that dictionary word exactly as written.\n" +
      "7. Never add words that are not in the meaning of the sentence and never translate to another language.\n" +
      "Examples:\n" +
      "Sentence: أنا بحب أمي وأبي -> [\"أنا\",\"أم\",\"أب\",\"يحب\"]\n" +
      "Sentence: مرحبا يا صديقي كيف حالك -> [\"أهلا وسهلا\",\"صديق\",\"كيف\",\"حال\"]";

    var userText = "كلمات القاموس المتاحة: " + vocabulary + "\nالجملة: " + sentence;

    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, LLM_TIMEOUT_MS);

    var response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemText }] },
          contents: [{ role: "user", parts: [{ text: userText }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: { type: "ARRAY", items: { type: "STRING" } }
          }
        }),
        signal: controller.signal
      });
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error("Gemini اتأخر في الرد (أكتر من " + LLM_TIMEOUT_MS / 1000 + " ثانية).");
      }
      throw new Error("مش قادر أوصل لـ Gemini. اتأكد من الإنترنت.");
    } finally {
      clearTimeout(timer);
    }

    var data = null;
    try {
      data = await response.json();
    } catch (err) {
      data = null;
    }

    if (!response.ok) {
      throw new Error(describeGeminiError(response.status, data));
    }

    var parts =
      data &&
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts;
    if (!parts || parts.length === 0) {
      throw new Error("Gemini رجّع رد فاضي (ممكن الرد اتحجب).");
    }
    var raw = parts
      .map(function (p) {
        return p.text || "";
      })
      .join("")
      .trim();

    var gloss = parseGlossJson(raw);
    console.log("Gemini gloss:", gloss);
    return gloss;
  }

  /* ---------- عرض الإشارات ---------- */

  function renderChips(items) {
    sequenceEl.innerHTML = "";
    chipEls = [];
    items.forEach(function (item) {
      var chip = document.createElement("span");
      chip.className = "chip" + (item.sign ? "" : " missing-chip");
      chip.textContent = item.token;
      sequenceEl.appendChild(chip);
      chipEls.push(chip);
    });
  }

  function setChipState(index, state) {
    var chip = chipEls[index];
    if (!chip) {
      return;
    }
    chip.classList.remove("active", "done", "missing-chip");
    chip.classList.add(state);
  }

  function showMissing(items) {
    var missing = items
      .filter(function (i) {
        return !i.sign;
      })
      .map(function (i) {
        return i.token;
      });
    if (missing.length > 0) {
      missingEl.textContent = "كلمات مش موجودة في القاموس التجريبي (اتخطّت): " + missing.join("، ");
      missingEl.hidden = false;
    } else {
      missingEl.textContent = "";
      missingEl.hidden = true;
    }
  }

  function stopPlayback() {
    runId += 1;
    if (cancelCurrent) {
      cancelCurrent();
    }
    video.pause();
  }

  function playMedia(file) {
    return new Promise(function (resolve) {
      var finished = false;
      var timer = null;

      function finish(ok) {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        video.onended = null;
        video.onerror = null;
        imageEl.onerror = null;
        cancelCurrent = null;
        resolve(ok);
      }

      cancelCurrent = function () {
        finish(false);
      };

      if (IMAGE_EXT.test(file)) {
        video.pause();
        imageEl.onerror = function () {
          finish(false);
        };
        imageEl.src = file + "?t=" + Date.now();
        showMedia("image");
        timer = setTimeout(function () {
          finish(true);
        }, IMAGE_DURATION_MS / speed);
        return;
      }

      video.onended = function () {
        finish(true);
      };
      video.onerror = function () {
        finish(false);
      };
      showMedia("video");
      video.src = file;
      video.defaultPlaybackRate = speed;
      video.playbackRate = speed;
      timer = setTimeout(function () {
        finish(false);
      }, VIDEO_TIMEOUT_MS);

      var playPromise = video.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(function (err) {
          if (err && err.name === "AbortError") {
            return;
          }
          finish(false);
        });
      }
    });
  }

  async function playItems(items) {
    stopPlayback();
    var myRun = runId;

    renderChips(items);
    showMissing(items);

    var playable = items.filter(function (i) {
      return i.sign;
    });
    if (playable.length === 0) {
      showMedia("none");
      currentWordEl.textContent = "مفيش كلمات من الجملة موجودة في القاموس التجريبي";
      setStatus("جاهز");
      return;
    }

    setStatus("بيتم عرض الإشارات...");
    var failedFiles = [];

    for (var i = 0; i < items.length; i++) {
      if (myRun !== runId) {
        return;
      }
      var item = items[i];
      if (!item.sign) {
        continue;
      }
      setChipState(i, "active");
      currentWordEl.textContent = item.sign.word;

      var ok = await playMedia(item.sign.file);
      if (myRun !== runId) {
        return;
      }
      if (ok) {
        setChipState(i, "done");
      } else {
        setChipState(i, "missing-chip");
        failedFiles.push(item.sign.file);
      }
    }

    currentWordEl.textContent = "انتهى العرض ✓";
    setStatus("جاهز");

    if (failedFiles.length > 0) {
      showError(
        "الملفات دي ماتفتحتش: " +
          failedFiles.join("، ") +
          ". اتأكد إن الملف موجود في مجلد signs وإن اسمه وامتداده مطابقين لـ dictionary.json."
      );
    }
  }

  /* ---------- المعالجة الأساسية للجملة ---------- */

  async function processSentence(sentence) {
    if (busy) {
      return;
    }
    busy = true;
    setControlsDisabled(true);
    clearError();

    var items = [];
    try {
      transcriptEl.textContent = sentence;
      glossEl.textContent = "...";

      var gloss = null;
      var usedLlm = false;

      if (useLlmEl.checked) {
        setStatus("Gemini بيرتّب الجملة...");
        try {
          gloss = await getGlossFromGemini(sentence);
          usedLlm = true;
        } catch (err) {
          showError(err.message + " — كملت من غير Gemini (مطابقة الكلمات مباشرة).");
        }
      }

      if (!gloss) {
        gloss = splitWords(sentence);
      }

      glossEl.textContent = gloss.join(" ← ") + (usedLlm ? "" : "   (بدون Gemini)");
      items = buildItems(gloss);
      lastItems = items;
    } catch (err) {
      showError("حصل خطأ غير متوقع: " + err.message);
      setStatus("جاهز");
    } finally {
      busy = false;
      setControlsDisabled(false);
    }

    if (items.length > 0) {
      playItems(items);
    } else {
      setStatus("جاهز");
    }
  }

  /* ---------- الميكروفون ---------- */

  function describeSpeechError(code) {
    if (code === "not-allowed" || code === "service-not-allowed") {
      return "Chrome مش مدّي صلاحية الميكروفون. اضغط على أيقونة القفل 🔒 جنب عنوان الصفحة ← Microphone ← Allow، وبعدها أعد تحميل الصفحة.";
    }
    if (code === "no-speech") {
      return "ما سمعتش صوت. قرّب من الميكروفون وكلم بوضوح وجرّب تاني.";
    }
    if (code === "audio-capture") {
      return "مفيش ميكروفون شغّال. اتأكد إنه متوصل ومش مستخدم في برنامج تاني (Zoom/Teams).";
    }
    if (code === "network") {
      return "خدمة التعرف على الصوت محتاجة إنترنت. اتأكد من الاتصال وجرّب تاني.";
    }
    if (code === "language-not-supported") {
      return "اللغة دي مش مدعومة. غيّر SPEECH_LANG في config.js إلى ar-SA.";
    }
    return "خطأ في التعرف على الصوت: " + code;
  }

  function setupRecognition() {
    var SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      return null;
    }

    var rec = new SpeechRecognitionCtor();
    rec.lang = typeof CONFIG !== "undefined" && CONFIG.SPEECH_LANG ? CONFIG.SPEECH_LANG : "ar-EG";
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = function () {
      isListening = true;
      updateMicButton();
      setStatus("بسمعك... اتكلم دلوقتي");
    };

    rec.onresult = function (event) {
      var finalPart = "";
      var interimPart = "";
      for (var i = 0; i < event.results.length; i++) {
        var result = event.results[i];
        if (result.isFinal) {
          finalPart += result[0].transcript;
        } else {
          interimPart += result[0].transcript;
        }
      }
      finalText = finalPart;
      interimText = interimPart;
      transcriptEl.textContent = (finalPart + " " + interimPart).trim();
    };

    rec.onerror = function (event) {
      if (event.error === "aborted") {
        return;
      }
      hadError = true;
      showError(describeSpeechError(event.error));
      setStatus("جاهز");
    };

    rec.onend = function () {
      isListening = false;
      updateMicButton();

      if (hadError) {
        return;
      }

      var text = (finalText || interimText).trim();
      if (!text) {
        setStatus("جاهز");
        showError("ما سمعتش كلام واضح. جرّب تاني وتكلم بعد ما الزرار يتحول للأحمر.");
        return;
      }
      processSentence(text);
    };

    return rec;
  }

  function toggleListening() {
    if (!recognition || busy) {
      return;
    }
    if (isListening) {
      recognition.stop();
      setStatus("بيتم إنهاء التسجيل...");
      return;
    }

    stopPlayback();
    clearError();
    finalText = "";
    interimText = "";
    hadError = false;
    transcriptEl.textContent = "...";

    try {
      recognition.start();
    } catch (err) {
      showError("مش قادر أبدأ التسجيل: " + err.message);
    }
  }

  /* ---------- أزرار الواجهة ---------- */

  function handleSend() {
    if (busy) {
      return;
    }
    if (isListening) {
      showError("وقّف التسجيل الأول وبعدين استخدم الكتابة.");
      return;
    }
    var text = textInput.value.trim();
    if (!text) {
      showError("اكتب جملة الأول.");
      return;
    }
    processSentence(text);
  }

  function handleReplay() {
    if (lastItems.length === 0) {
      setStatus("مفيش حاجة لإعادة عرضها");
      return;
    }
    clearError();
    playItems(lastItems);
  }

  function handleClear() {
    stopPlayback();
    video.removeAttribute("src");
    video.load();
    imageEl.removeAttribute("src");
    showMedia("none");
    lastItems = [];
    chipEls = [];
    sequenceEl.innerHTML = "";
    missingEl.textContent = "";
    missingEl.hidden = true;
    transcriptEl.textContent = "لسه مفيش كلام...";
    glossEl.textContent = "لسه مفيش نتيجة...";
    currentWordEl.innerHTML = "&nbsp;";
    textInput.value = "";
    clearError();
    setStatus("جاهز");
  }

  function handleSpeedChange() {
    var value = parseFloat(speedSelect.value);
    speed = isFinite(value) && value > 0 ? value : 1;
    video.defaultPlaybackRate = speed;
    video.playbackRate = speed;
  }

  /* ---------- التشغيل الأولي ---------- */

  async function init() {
    micBtn.addEventListener("click", toggleListening);
    sendBtn.addEventListener("click", handleSend);
    replayBtn.addEventListener("click", handleReplay);
    clearBtn.addEventListener("click", handleClear);
    speedSelect.addEventListener("change", handleSpeedChange);
    textInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        handleSend();
      }
    });

    if (window.location.protocol === "file:") {
      showError("الصفحة مفتوحة كملف مباشر (file://). شغّلها بـ Live Server (زرار Go Live) عشان الميكروفون والقاموس يشتغلوا.");
    }

    if (typeof CONFIG === "undefined") {
      showError("ملف config.js مش متحمّل. اتأكد إنه موجود جنب index.html وإن اسمه صح.");
    }

    try {
      await loadDictionary();
    } catch (err) {
      showError(err.message);
      setStatus("القاموس مش متحمّل");
      sendBtn.disabled = true;
      micBtn.disabled = true;
      return;
    }

    recognition = setupRecognition();
    if (!recognition) {
      micBtn.disabled = true;
      showError("المتصفح ده مش بيدعم التعرف على الصوت. استخدم Google Chrome. وتقدر تجرّب بالكتابة في الوقت ده.");
    }

    updateMicButton();
    setStatus("جاهز");
  }

  init();
})();