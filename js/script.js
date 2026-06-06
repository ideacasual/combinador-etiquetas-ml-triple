/**
 * Main application script to handle UI interactions
 */

document.addEventListener("DOMContentLoaded", function () {
  // ========== LOCAL UTILITIES ==========
  function escapeHTML(str) {
    const div = document.createElement("div");
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // ========== DOM ELEMENTS ==========
  const fileInput = document.getElementById("fileInput");
  const fileDropZone = document.getElementById("fileDropZone");
  const browseBtn = document.querySelector(".browse-btn");
  const fileList = document.getElementById("fileList");
  const fileItems = document.getElementById("fileItems");
  const processSetsBtn = document.getElementById("processSetsBtn");
  const processSinglesBtn = document.getElementById("processSinglesBtn");
  const downloadSection = document.getElementById("downloadSection");
  const clearFilesBtn = document.getElementById("clearFilesBtn");
  const actionButtons = document.getElementById("actionButtons");

  let selectedFiles = [];
  let isAddingFiles = false; // 🔒 Lock para evitar concurrencia en addFiles

  // Constants
  const MAX_FILES = 10;

  // Initialize
  function init() {
    setupEventListeners();
    updateProcessButtons();
    updateDropZoneLimitState();

    // Clean up blob URLs on page unload
    window.addEventListener("beforeunload", () => {
      if (window.pdfBlobUrls) {
        window.pdfBlobUrls.forEach((url) => {
          try {
            URL.revokeObjectURL(url);
          } catch (e) {}
        });
        window.pdfBlobUrls = [];
      }
    });
  }

  function setupEventListeners() {
    fileInput.addEventListener("change", handleFileSelect);

    // Browse button – must be synchronous to be considered a user gesture
    browseBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      fileInput.click();
    });

    if (clearFilesBtn) {
      clearFilesBtn.addEventListener("click", clearFiles);
    }

    fileDropZone.addEventListener("click", () => fileInput.click());
    fileDropZone.addEventListener("dragover", handleDragOver);
    fileDropZone.addEventListener("dragleave", handleDragLeave);
    fileDropZone.addEventListener("drop", handleDrop);

    // Prevenir comportamiento por defecto en el documento (seguridad)
    document.addEventListener("dragover", (e) => e.preventDefault());
    document.addEventListener("drop", (e) => e.preventDefault());

    processSetsBtn.addEventListener("click", () => processFiles("sets"));
    processSinglesBtn.addEventListener("click", () => processFiles("singles"));
  }

  // ========== FILE HANDLING ==========
  function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    addFiles(files);
    fileInput.value = ""; // allow re‑selection of the same files
  }

  function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    fileDropZone.classList.add("dragover");
    if (selectedFiles.length >= MAX_FILES) {
      fileDropZone.classList.add("limit-reached");
    }
  }

  function handleDragLeave(e) {
    e.stopPropagation();
    fileDropZone.classList.remove("dragover");
    fileDropZone.classList.remove("limit-reached");
  }

  function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    fileDropZone.classList.remove("dragover");
    fileDropZone.classList.remove("limit-reached");
    const files = Array.from(e.dataTransfer.files);
    addFiles(files);
  }

  // ========== VALIDATION ==========
  function validatePDF(file) {
    const fileName = file.name.toLowerCase();
    if (!fileName.endsWith(".pdf")) {
      return { valid: false, reason: "El archivo tiene que ser .pdf" };
    }
    const maxSize = 1 * 1024 * 1024; // 1 MB
    if (file.size > maxSize) {
      return { valid: false, reason: "El archivo es muy pesado (máximo 1MB)" };
    }
    if (file.size === 0) {
      return { valid: false, reason: "Archivo vacío" };
    }
    return { valid: true, reason: "Archivo PDF válido" };
  }

  async function checkPDFPages(file) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const pageCount = pdf.numPages;

      // 1. Must have exactly 2 pages
      if (pageCount !== Config.EXPECTED_PAGES_COUNT) {
        await pdf.destroy();
        return {
          pageCount,
          isValid: false,
          reason: `Se esperaban ${Config.EXPECTED_PAGES_COUNT} páginas, se encontraron ${pageCount}`,
        };
      }

      // 2. Check orientations (Page 1 landscape, Page 2 portrait)
      const page1 = await pdf.getPage(1);
      const page2 = await pdf.getPage(2);
      const vp1 = page1.getViewport({ scale: 1 });
      const vp2 = page2.getViewport({ scale: 1 });

      const page1Landscape = vp1.width > vp1.height;
      const page2Portrait = vp2.height > vp2.width;

      await pdf.destroy();

      if (!page1Landscape) {
        return {
          pageCount,
          isValid: false,
          reason: "Página 1 debe ser apaisada (horizontal), pero es vertical",
        };
      }
      if (!page2Portrait) {
        return {
          pageCount,
          isValid: false,
          reason: "Página 2 debe ser vertical (retrato), pero es apaisada",
        };
      }

      return {
        pageCount,
        isValid: true,
        reason: "Válido (2 páginas, orientaciones correctas)",
      };
    } catch (error) {
      console.error("checkPDFPages error:", error);
      return {
        pageCount: 0,
        isValid: false,
        reason: "Formato PDF inválido o archivo corrupto",
      };
    }
  }

  async function addFiles(files) {
    // 🔒 Evitar ejecuciones concurrentes (carrera)
    if (isAddingFiles || files.length === 0) return;
    isAddingFiles = true;

    try {
      const totalAfterAdd = selectedFiles.length + files.length;
      if (totalAfterAdd > MAX_FILES) {
        const exceso = totalAfterAdd - MAX_FILES;
        pdfProcessor.updateStatus(
          `No se pueden agregar ${files.length} archivos. Máximo ${MAX_FILES} permitidos. Excedés por ${exceso} archivo${exceso > 1 ? "s" : ""}.`,
          "error",
        );
        return;
      }

      pdfProcessor.updateStatus(
        `Verificando ${files.length} archivo${files.length > 1 ? "s" : ""}...`,
        "processing",
      );

      const validFiles = [];
      const invalidFiles = [];

      for (const file of files) {
        const validation = validatePDF(file);
        if (!validation.valid) {
          invalidFiles.push({ file, reason: validation.reason });
        } else {
          validFiles.push(file);
        }
      }

      if (invalidFiles.length > 0) {
        const errorMsg =
          `${invalidFiles.length} archivo${invalidFiles.length > 1 ? "s" : ""} no válido${invalidFiles.length > 1 ? "s" : ""} omitido${invalidFiles.length > 1 ? "s" : ""}: ` +
          invalidFiles.map((f) => `${f.file.name} (${f.reason})`).join(", ");
        pdfProcessor.updateStatus(errorMsg, "error");
      }

      if (validFiles.length === 0) {
        pdfProcessor.updateStatus(
          "No se encontraron archivos PDF válidos",
          "error",
        );
        return;
      }

      pdfProcessor.updateStatus(
        "Verificando que cada PDF tenga exactamente 2 páginas...",
        "processing",
      );

      const filesWithPageInfo = [];
      const invalidPageFiles = [];

      for (const file of validFiles) {
        const pageInfo = await checkPDFPages(file);
        if (pageInfo.isValid) {
          filesWithPageInfo.push({
            file,
            pageCount: pageInfo.pageCount,
            status: "valid",
          });
        } else {
          invalidPageFiles.push({ file, reason: pageInfo.reason });
        }
      }

      filesWithPageInfo.forEach((fileInfo) => {
        const existingIndex = selectedFiles.findIndex(
          (f) =>
            f.name === fileInfo.file.name &&
            f.size === fileInfo.file.size &&
            f.lastModified === fileInfo.file.lastModified,
        );
        if (existingIndex === -1) {
          selectedFiles.push(fileInfo.file);
        }
      });

      updateFileList();
      updateProcessButtons();
      updateDropZoneLimitState();

      let statusMessage = "";
      if (filesWithPageInfo.length > 0) {
        const cantidad = filesWithPageInfo.length;
        statusMessage += `✅ ${cantidad} archivo${cantidad > 1 ? "s" : ""} PDF válido${cantidad > 1 ? "s" : ""} (2 páginas, orientaciones correctas). `;
      }
      if (invalidPageFiles.length > 0) {
        const cantidad = invalidPageFiles.length;
        statusMessage +=
          `⚠️ ${cantidad} archivo${cantidad > 1 ? "s" : ""} no cumplen los requisitos: ` +
          invalidPageFiles
            .map((f) => `${f.file.name} (${f.reason})`)
            .join(", ");
      }
      if (statusMessage) {
        const type = invalidPageFiles.length > 0 ? "error" : "success";
        pdfProcessor.updateStatus(statusMessage, type);
      }

      if (
        selectedFiles.length >= MAX_FILES - 2 &&
        selectedFiles.length < MAX_FILES
      ) {
        const remaining = MAX_FILES - selectedFiles.length;
        pdfProcessor.updateStatus(
          `Podés agregar ${remaining} archivo${remaining > 1 ? "s" : ""} más (máximo ${MAX_FILES})`,
          "processing",
        );
      } else if (selectedFiles.length >= MAX_FILES) {
        pdfProcessor.updateStatus(
          `Límite máximo de ${MAX_FILES} archivos alcanzado`,
          "processing",
        );
      }
    } finally {
      isAddingFiles = false;
    }
  }

  // ========== UI UPDATES ==========
  function updateDropZoneLimitState() {
    if (selectedFiles.length >= MAX_FILES) {
      fileDropZone.classList.add("limit-reached");
      fileDropZone.querySelector("h3").textContent = "Límite máximo alcanzado";
      fileDropZone.querySelector("p").textContent =
        "Limpiá archivos para agregar más";
    } else {
      fileDropZone.classList.remove("limit-reached");
      fileDropZone.querySelector("h3").textContent =
        "Arrastrá archivos PDF acá";
      fileDropZone.querySelector("p").textContent =
        "o hacé clic para buscar tus archivos";
    }
  }

  function updateFileList() {
    if (selectedFiles.length === 0) {
      fileList.style.display = "none";
      return;
    }
    fileList.style.display = "block";
    fileItems.innerHTML = "";

    selectedFiles.forEach((file, index) => {
      const item = document.createElement("div");
      item.className = "file-item";

      const fileInfo = document.createElement("div");
      fileInfo.className = "file-info";
      fileInfo.innerHTML = `
        <div>📄</div>
        <div class="file-details">
          <div class="file-name" title="${escapeHTML(file.name)}">${escapeHTML(file.name)}</div>
          <div class="file-status status-valid">${(file.size / 1024).toFixed(1)} KB • 2 páginas</div>
        </div>
      `;

      const removeBtn = document.createElement("button");
      removeBtn.innerHTML = "×";
      removeBtn.title = "Eliminar archivo";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeFile(index);
      });

      item.appendChild(fileInfo);
      item.appendChild(removeBtn);
      fileItems.appendChild(item);
    });

    const fileCount = document.createElement("div");
    fileCount.className = "file-count";
    const cantidad = selectedFiles.length;
    fileCount.textContent = `${cantidad} archivo${cantidad > 1 ? "s" : ""} seleccionado${cantidad > 1 ? "s" : ""} (máximo ${MAX_FILES})`;
    fileItems.appendChild(fileCount);
  }

  function removeFile(index) {
    const removedFile = selectedFiles[index];
    selectedFiles.splice(index, 1);
    updateFileList();
    updateProcessButtons();
    updateDropZoneLimitState();
    if (selectedFiles.length === 0) {
      pdfProcessor.updateStatus(
        "Por favor, seleccioná archivos PDF para comenzar",
        "info",
      );
    } else {
      pdfProcessor.updateStatus(
        `Eliminado: ${removedFile.name}. ${selectedFiles.length} archivo${selectedFiles.length > 1 ? "s" : ""} restante${selectedFiles.length > 1 ? "s" : ""}`,
        "info",
      );
    }
  }

  function updateProcessButtons() {
    const hasFiles = selectedFiles.length > 0;
    processSetsBtn.disabled = !hasFiles;
    processSinglesBtn.disabled = !hasFiles;

    if (hasFiles) {
      let temp = selectedFiles.length;
      let triples = 0,
        dobles = 0,
        simples = 0;
      while (temp >= 3) {
        triples++;
        temp -= 3;
      }
      if (temp === 2) {
        dobles = 1;
        temp -= 2;
      }
      simples = temp;

      const parts = [];
      if (triples > 0) parts.push(`${triples} triple${triples > 1 ? "s" : ""}`);
      if (dobles > 0) parts.push(`${dobles} doble${dobles > 1 ? "s" : ""}`);
      if (simples > 0) parts.push(`${simples} simple${simples > 1 ? "s" : ""}`);
      const description = parts.length > 0 ? `(${parts.join(", ")})` : "";
      processSetsBtn.textContent = `Procesar como Conjuntos ${description}`;
      processSinglesBtn.textContent = `Procesar como Individuales (${selectedFiles.length} salida${selectedFiles.length > 1 ? "s" : ""})`;
    } else {
      processSetsBtn.textContent = "Procesar como Conjuntos";
      processSinglesBtn.textContent = "Procesar como Individuales";
    }
  }

  // ========== PROCESSING ==========
  async function processFiles(mode) {
    if (selectedFiles.length === 0) {
      pdfProcessor.updateStatus("No hay archivos seleccionados", "error");
      return;
    }

    disableUI(true);
    downloadSection.style.display = "none";
    pdfProcessor.updateProgress(0);
    pdfProcessor.updateStatus("Iniciando procesamiento...", "processing");

    try {
      const results = await pdfProcessor.processFiles(selectedFiles, mode);
      if (results.length > 0) {
        pdfProcessor.displayResults(results);
        if (actionButtons) {
          actionButtons.innerHTML = "";
          const clearBtn = document.createElement("button");
          clearBtn.textContent = "Limpiar archivos y empezar de nuevo";
          clearBtn.className = "browse-btn";
          clearBtn.onclick = clearFiles;
          actionButtons.appendChild(clearBtn);
        }
      }
    } catch (error) {
      console.error("Error de procesamiento:", error);
      pdfProcessor.updateStatus(
        "Error en el procesamiento: " + error.message,
        "error",
      );
    } finally {
      disableUI(false);
    }
  }

  function disableUI(disabled) {
    processSetsBtn.disabled = disabled;
    processSinglesBtn.disabled = disabled;
    fileInput.disabled = disabled;
    browseBtn.disabled = disabled;
    if (clearFilesBtn) clearFilesBtn.disabled = disabled;
    if (disabled) {
      fileDropZone.style.opacity = "0.5";
      fileDropZone.style.pointerEvents = "none";
    } else {
      fileDropZone.style.opacity = "1";
      fileDropZone.style.pointerEvents = "auto";
      updateProcessButtons();
    }
  }

  // ========== CLEAR ==========
  function clearFiles() {
    selectedFiles = [];
    fileInput.value = "";
    updateFileList();
    updateProcessButtons();
    updateDropZoneLimitState();
    downloadSection.style.display = "none";
    pdfProcessor.updateStatus(
      "Por favor, seleccioná archivos PDF para comenzar",
      "info",
    );
    pdfProcessor.updateProgress(0);
    // ✅ Delegamos toda la limpieza de memoria al procesador
    if (window.pdfProcessor) {
      window.pdfProcessor.clearMemory();
    }
    if (actionButtons) actionButtons.innerHTML = "";
  }

  // ========== KEYBOARD SHORTCUTS ==========
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "o") {
      e.preventDefault();
      fileInput.click();
    }
    if (e.key === "Escape" && !fileInput.disabled) {
      clearFiles();
    }
  });

  init();
});
