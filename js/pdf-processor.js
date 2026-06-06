/**
 * PDF Processor - Procesa PDFs en sets: triples, dobles o simples
 * Reglas de procesamiento de páginas:
 * - Página 1: recortada verticalmente
 * - Página 2: recorte superior 20%, escala 50%, posición inferior izquierda.
 * Conversión a grises: por GPU, solo una vez sobre el canvas final.
 * Carga de PDFs: secuencial para control de memoria.
 */

// ========== FUNCIONES AUXILIARES ==========
function escapeHTML(str) {
  const div = document.createElement("div");
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

// ========== CONSTANTES DE CONFIGURACIÓN ==========
const Config = {
  DPI: 300,
  A4_LANDSCAPE_WIDTH: 3508,
  A4_LANDSCAPE_HEIGHT: 2480,

  SECTION_FILE1_CROP_LEFT: 0,
  SECTION_FILE1_CROP_RIGHT: 1200,
  SECTION_OTHER_CROP_LEFT: 125,
  SECTION_OTHER_CROP_RIGHT: 1200,
  SECTION_FILE1_WIDTH: 1200,
  SECTION_OTHER_WIDTH: 1075,
  SECTION_GAP: 20,

  PAGE2_CROP_TOP_PERCENT: 0.2,
  PAGE2_SCALE_FACTOR: 0.5,
  PAGE2_BOTTOM_MARGIN: 50,
  PAGE2_LEFT_MARGIN: 50,

  EXPECTED_PAGES_COUNT: 2,

  TRIPLE_PREFIX: "triple",
  DOBLE_PREFIX: "doble",
  SIMPLE_PREFIX: "simple",

  IMAGE_QUALITY: 1.0,
  IMAGE_FORMAT: "png",
};

class PDFProcessor {
  constructor() {
    this.isProcessing = false; // ← Reinicializado
    if (typeof pdfjsLib !== "undefined") {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }
  }

  // ========== MEMORY & UTILITY ==========

  /**
   * Libera la memoria de un canvas inmediatamente forzando width=0.
   */
  clearCanvas(canvas) {
    if (canvas && canvas.width) canvas.width = 0;
  }

  clearMemory() {
    if (window.pdfBlobUrls) {
      window.pdfBlobUrls.forEach((url) => {
        try {
          URL.revokeObjectURL(url);
        } catch (e) {}
      });
      window.pdfBlobUrls = [];
    }
  }

  async checkDependencies() {
    const errors = [];
    if (typeof pdfjsLib === "undefined")
      errors.push("PDF.js library not loaded");
    if (typeof window.jspdf === "undefined")
      errors.push("jsPDF library not loaded");
    if (errors.length > 0) {
      throw new Error(
        `Faltan dependencias: ${errors.join(", ")}. Recargá la página.`,
      );
    }
  }

  // ========== PROCESAMIENTO DE IMAGEN ==========

  convertToGrayscale(canvas) {
    const temp = document.createElement("canvas");
    temp.className = "temp-canvas";
    temp.width = canvas.width;
    temp.height = canvas.height;
    const ctx = temp.getContext("2d");
    ctx.filter = "grayscale(100%)";
    ctx.drawImage(canvas, 0, 0);
    return temp;
  }

  async loadPDF(file) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

      if (pdf.numPages !== Config.EXPECTED_PAGES_COUNT) {
        throw new Error(
          `Se esperaban ${Config.EXPECTED_PAGES_COUNT} páginas, se encontraron ${pdf.numPages}`,
        );
      }

      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: Config.DPI / 72 });
        const canvas = document.createElement("canvas");
        canvas.className = "temp-canvas";
        const context = canvas.getContext("2d");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: context, viewport: viewport })
          .promise;
        pages.push(canvas);
      }

      await pdf.destroy();
      return pages;
    } catch (error) {
      console.error(`Error al cargar el PDF ${file.name}:`, error);
      throw error;
    }
  }

  cropPage2TopOnly(canvas) {
    const cropHeight = Math.floor(
      canvas.height * Config.PAGE2_CROP_TOP_PERCENT,
    );
    const croppedCanvas = document.createElement("canvas");
    croppedCanvas.className = "temp-canvas";
    croppedCanvas.width = canvas.width;
    croppedCanvas.height = cropHeight;
    const croppedCtx = croppedCanvas.getContext("2d");
    croppedCtx.drawImage(
      canvas,
      0,
      0,
      canvas.width,
      cropHeight,
      0,
      0,
      canvas.width,
      cropHeight,
    );
    return croppedCanvas;
  }

  resizePage2(canvas) {
    const availableWidth = Config.A4_LANDSCAPE_WIDTH / 2;
    const availableHeight = Config.A4_LANDSCAPE_HEIGHT / 3;
    const maxWidth = availableWidth * Config.PAGE2_SCALE_FACTOR;
    const maxHeight = availableHeight * Config.PAGE2_SCALE_FACTOR;
    const originalRatio = canvas.width / canvas.height;
    let newWidth, newHeight;
    if (originalRatio > maxWidth / maxHeight) {
      newWidth = maxWidth;
      newHeight = newWidth / originalRatio;
    } else {
      newHeight = maxHeight;
      newWidth = newHeight * originalRatio;
    }
    newWidth = Math.min(newWidth, maxWidth);
    newHeight = Math.min(newHeight, maxHeight);
    const resizedCanvas = document.createElement("canvas");
    resizedCanvas.className = "temp-canvas";
    resizedCanvas.width = newWidth;
    resizedCanvas.height = newHeight;
    const resizedCtx = resizedCanvas.getContext("2d");
    resizedCtx.drawImage(
      canvas,
      0,
      0,
      canvas.width,
      canvas.height,
      0,
      0,
      newWidth,
      newHeight,
    );
    return resizedCanvas;
  }

  processPage2(canvas) {
    const cropped = this.cropPage2TopOnly(canvas);
    const resized = this.resizePage2(cropped);
    this.clearCanvas(cropped); // ← Se libera el canvas intermedio
    return resized;
  }

  async createSectionLayout(pdfPages, isFirstFile) {
    if (pdfPages.length !== Config.EXPECTED_PAGES_COUNT) {
      throw new Error(
        `Se esperaban ${Config.EXPECTED_PAGES_COUNT} páginas, se encontraron ${pdfPages.length}`,
      );
    }

    let cropLeft, cropRight, sectionWidth;
    if (isFirstFile) {
      cropLeft = Config.SECTION_FILE1_CROP_LEFT;
      cropRight = Config.SECTION_FILE1_CROP_RIGHT;
      sectionWidth = Config.SECTION_FILE1_WIDTH;
    } else {
      cropLeft = Config.SECTION_OTHER_CROP_LEFT;
      cropRight = Config.SECTION_OTHER_CROP_RIGHT;
      sectionWidth = Config.SECTION_OTHER_WIDTH;
    }

    const sectionCanvas = document.createElement("canvas");
    sectionCanvas.className = "temp-canvas";
    sectionCanvas.width = sectionWidth;
    sectionCanvas.height = Config.A4_LANDSCAPE_HEIGHT;
    const ctx = sectionCanvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, sectionCanvas.width, sectionCanvas.height);

    // Página 1: recorte horizontal y escalado si es necesario
    const page1Canvas = pdfPages[0];
    const croppedWidth = cropRight - cropLeft;
    const croppedCanvas = document.createElement("canvas");
    croppedCanvas.className = "temp-canvas";
    croppedCanvas.width = croppedWidth;
    croppedCanvas.height = page1Canvas.height;
    const croppedCtx = croppedCanvas.getContext("2d");
    croppedCtx.drawImage(
      page1Canvas,
      cropLeft,
      0,
      croppedWidth,
      page1Canvas.height,
      0,
      0,
      croppedWidth,
      page1Canvas.height,
    );

    const sectionHeight = Config.A4_LANDSCAPE_HEIGHT;
    let destWidth = croppedWidth;
    let destHeight = croppedCanvas.height;
    if (destHeight > sectionHeight) {
      const scale = sectionHeight / destHeight;
      destWidth = Math.floor(croppedWidth * scale);
      destHeight = sectionHeight;
    }
    ctx.drawImage(croppedCanvas, 0, 0, destWidth, destHeight);

    this.clearCanvas(page1Canvas);
    this.clearCanvas(croppedCanvas);

    // Página 2 procesada
    const page2Processed = this.processPage2(pdfPages[1]);
    const page2X = Config.PAGE2_LEFT_MARGIN;
    const page2Y =
      Config.A4_LANDSCAPE_HEIGHT -
      page2Processed.height -
      Config.PAGE2_BOTTOM_MARGIN;
    ctx.drawImage(page2Processed, page2X, page2Y);

    this.clearCanvas(pdfPages[1]);
    this.clearCanvas(page2Processed);

    return sectionCanvas;
  }

  async processPDFTriple(pdf1File, pdf2File, pdf3File) {
    const pdf1Pages = await this.loadPDF(pdf1File);
    const doc1Image = await this.createSectionLayout(pdf1Pages, true);

    const pdf2Pages = await this.loadPDF(pdf2File);
    const doc2Image = await this.createSectionLayout(pdf2Pages, false);

    const pdf3Pages = await this.loadPDF(pdf3File);
    const doc3Image = await this.createSectionLayout(pdf3Pages, false);

    const finalCanvas = document.createElement("canvas");
    finalCanvas.className = "temp-canvas";
    finalCanvas.width = Config.A4_LANDSCAPE_WIDTH;
    finalCanvas.height = Config.A4_LANDSCAPE_HEIGHT;
    const finalCtx = finalCanvas.getContext("2d");
    finalCtx.fillStyle = "white";
    finalCtx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);

    const xPositions = [
      0,
      Config.SECTION_FILE1_WIDTH + Config.SECTION_GAP,
      Config.SECTION_FILE1_WIDTH +
        Config.SECTION_OTHER_WIDTH +
        2 * Config.SECTION_GAP,
    ];
    finalCtx.drawImage(doc1Image, xPositions[0], 0);
    finalCtx.drawImage(doc2Image, xPositions[1], 0);
    finalCtx.drawImage(doc3Image, xPositions[2], 0);

    this.clearCanvas(doc1Image);
    this.clearCanvas(doc2Image);
    this.clearCanvas(doc3Image);

    const grayCanvas = this.convertToGrayscale(finalCanvas);
    this.clearCanvas(finalCanvas);

    const blob = this.generatePDFBlob(grayCanvas);
    this.clearCanvas(grayCanvas); // ← Se libera después del blob
    return blob;
  }

  async processPDFDoble(pdf1File, pdf2File) {
    const pdf1Pages = await this.loadPDF(pdf1File);
    const doc1Image = await this.createSectionLayout(pdf1Pages, true);

    const pdf2Pages = await this.loadPDF(pdf2File);
    const doc2Image = await this.createSectionLayout(pdf2Pages, false);

    const finalCanvas = document.createElement("canvas");
    finalCanvas.className = "temp-canvas";
    finalCanvas.width = Config.A4_LANDSCAPE_WIDTH;
    finalCanvas.height = Config.A4_LANDSCAPE_HEIGHT;
    const finalCtx = finalCanvas.getContext("2d");
    finalCtx.fillStyle = "white";
    finalCtx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);

    finalCtx.drawImage(doc1Image, 0, 0);
    finalCtx.drawImage(
      doc2Image,
      Config.SECTION_FILE1_WIDTH + Config.SECTION_GAP,
      0,
    );

    this.clearCanvas(doc1Image);
    this.clearCanvas(doc2Image);

    const grayCanvas = this.convertToGrayscale(finalCanvas);
    this.clearCanvas(finalCanvas);

    const blob = this.generatePDFBlob(grayCanvas);
    this.clearCanvas(grayCanvas);
    return blob;
  }

  async processPDFSimple(pdfFile) {
    const pdfPages = await this.loadPDF(pdfFile);
    const sectionImage = await this.createSectionLayout(pdfPages, true);

    const finalCanvas = document.createElement("canvas");
    finalCanvas.className = "temp-canvas";
    finalCanvas.width = Config.A4_LANDSCAPE_WIDTH;
    finalCanvas.height = Config.A4_LANDSCAPE_HEIGHT;
    const finalCtx = finalCanvas.getContext("2d");
    finalCtx.fillStyle = "white";
    finalCtx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);

    finalCtx.drawImage(sectionImage, 0, 0);
    this.clearCanvas(sectionImage);

    const grayCanvas = this.convertToGrayscale(finalCanvas);
    this.clearCanvas(finalCanvas);

    const blob = this.generatePDFBlob(grayCanvas);
    this.clearCanvas(grayCanvas);
    return blob;
  }

  // ========== GENERACIÓN DE PDF FINAL ==========

  generatePDFBlob(canvas) {
    if (typeof window.jspdf === "undefined") {
      throw new Error("jsPDF no está cargado. Incluilo en tu HTML.");
    }
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({
      orientation: "landscape",
      unit: "px",
      format: [Config.A4_LANDSCAPE_WIDTH, Config.A4_LANDSCAPE_HEIGHT],
      compress: true,
    });
    pdf.addImage(
      canvas,
      "PNG",
      0,
      0,
      Config.A4_LANDSCAPE_WIDTH,
      Config.A4_LANDSCAPE_HEIGHT,
    );
    return pdf.output("blob");
  }

  // ========== INTERFAZ PÚBLICA ==========

  async processFiles(files, mode) {
    await this.checkDependencies();
    if (this.isProcessing) throw new Error("Ya se están procesando archivos");
    this.isProcessing = true;
    const results = [];
    try {
      if (mode === "sets") {
        let i = 0,
          tripleCount = 0,
          dobleCount = 0,
          simpleCount = 0;
        while (i < files.length) {
          const remaining = files.length - i;
          if (remaining >= 3) {
            tripleCount++;
            const [pdf1, pdf2, pdf3] = [files[i], files[i + 1], files[i + 2]];
            this.updateProgress((i / files.length) * 100);
            this.updateStatus(
              `Procesando triple ${tripleCount}...`,
              "processing",
            );
            try {
              const blob = await this.processPDFTriple(pdf1, pdf2, pdf3);
              const timestamp = Date.now();
              const filename = `${Config.TRIPLE_PREFIX}${tripleCount.toString().padStart(2, "0")}_${timestamp}.pdf`;
              results.push({
                filename,
                blob,
                files: [pdf1.name, pdf2.name, pdf3.name],
                type: "triple",
                tripleNumber: tripleCount,
                size: blob.size,
              });
            } catch (error) {
              console.error(
                `Error al procesar el triple ${tripleCount}:`,
                error,
              );
              this.updateStatus(
                `Error al procesar el triple ${tripleCount}: ${error.message}`,
                "error",
              );
            }
            i += 3;
          } else if (remaining === 2) {
            dobleCount++;
            const [pdf1, pdf2] = [files[i], files[i + 1]];
            this.updateProgress((i / files.length) * 100);
            this.updateStatus(
              `Procesando doble ${dobleCount}...`,
              "processing",
            );
            try {
              const blob = await this.processPDFDoble(pdf1, pdf2);
              const timestamp = Date.now();
              const filename = `${Config.DOBLE_PREFIX}${dobleCount.toString().padStart(2, "0")}_${timestamp}.pdf`;
              results.push({
                filename,
                blob,
                files: [pdf1.name, pdf2.name],
                type: "doble",
                dobleNumber: dobleCount,
                size: blob.size,
              });
            } catch (error) {
              console.error(`Error al procesar el doble ${dobleCount}:`, error);
              this.updateStatus(
                `Error al procesar el doble ${dobleCount}: ${error.message}`,
                "error",
              );
            }
            i += 2;
          } else {
            simpleCount++;
            const pdf = files[i];
            this.updateProgress((i / files.length) * 100);
            this.updateStatus(
              `Procesando simple ${simpleCount}...`,
              "processing",
            );
            try {
              const blob = await this.processPDFSimple(pdf);
              const timestamp = Date.now();
              const filename = `${Config.SIMPLE_PREFIX}${simpleCount.toString().padStart(2, "0")}_${timestamp}.pdf`;
              results.push({
                filename,
                blob,
                files: [pdf.name],
                type: "simple",
                simpleNumber: simpleCount,
                size: blob.size,
              });
            } catch (error) {
              console.error(
                `Error al procesar el simple ${simpleCount}:`,
                error,
              );
              this.updateStatus(
                `Error al procesar el simple ${simpleCount}: ${error.message}`,
                "error",
              );
            }
            i += 1;
          }
        }
      } else if (mode === "singles") {
        for (let i = 0; i < files.length; i++) {
          this.updateProgress((i / files.length) * 100);
          this.updateStatus(
            `Procesando archivo ${i + 1} de ${files.length}...`,
            "processing",
          );
          const pdf = files[i];
          try {
            const blob = await this.processPDFSimple(pdf);
            const timestamp = Date.now();
            const filename = `${Config.SIMPLE_PREFIX}_${(i + 1).toString().padStart(2, "0")}_${timestamp}.pdf`;
            results.push({
              filename,
              blob,
              files: [pdf.name],
              type: "simple",
              fileNumber: i + 1,
              size: blob.size,
            });
          } catch (error) {
            console.error(`Error al procesar ${pdf.name}:`, error);
            this.updateStatus(
              `Error al procesar ${pdf.name}: ${error.message}`,
              "error",
            );
          }
        }
      }
      this.updateProgress(100);
      if (results.length > 0) {
        const totalSizeMB = (
          results.reduce((sum, r) => sum + r.size, 0) /
          (1024 * 1024)
        ).toFixed(2);
        const triples = results.filter((r) => r.type === "triple").length;
        const dobles = results.filter((r) => r.type === "doble").length;
        const simples = results.filter((r) => r.type === "simple").length;
        let summaryParts = [];
        if (triples > 0)
          summaryParts.push(`${triples} triple${triples > 1 ? "s" : ""}`);
        if (dobles > 0)
          summaryParts.push(`${dobles} doble${dobles > 1 ? "s" : ""}`);
        if (simples > 0)
          summaryParts.push(`${simples} simple${simples > 1 ? "s" : ""}`);
        const summary = summaryParts.join(", ");
        this.updateStatus(
          `¡Proceso completado! ${results.length} archivo(s) PDF generados (${summary}) - ${totalSizeMB} MB`,
          "success",
        );
      } else {
        this.updateStatus(
          "No se procesó ningún archivo correctamente",
          "error",
        );
      }
      return results;
    } finally {
      this.isProcessing = false;
    }
  }

  // ========== UI HELPERS ==========

  updateStatus(message, type = "info") {
    const el = document.getElementById("status");
    if (el) {
      el.textContent = message;
      el.className = `status status-${type}`;
    }
  }

  updateProgress(percentage) {
    const bar = document.getElementById("progressBar");
    if (bar) bar.style.width = `${percentage}%`;
  }

  createDownloadLink(filename, blob) {
    const url = URL.createObjectURL(blob);
    if (!window.pdfBlobUrls) window.pdfBlobUrls = [];
    window.pdfBlobUrls.push(url);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.textContent = "Descargar PDF";
    link.className = "download-link";
    link.title = `${filename} (${(blob.size / 1024).toFixed(0)} KB)`;
    link._blob = blob;
    link._blobUrl = url;
    let isDownloading = false;
    link.onclick = (e) => {
      if (isDownloading) {
        e.preventDefault();
        return false;
      }
      isDownloading = true;
      const originalText = link.textContent;
      link.textContent = "⏳ Descargando...";
      link.style.opacity = "0.7";
      link.style.cursor = "wait";
      setTimeout(() => {
        link.textContent = "✓ Descargado (click para otra copia)";
        link.style.opacity = "0.8";
        link.style.cursor = "pointer";
        isDownloading = false;
      }, 1000);
      return true;
    };
    return link;
  }

  displayResults(results) {
    const downloadSection = document.getElementById("downloadSection");
    const downloadList = document.getElementById("downloadList");
    if (!downloadSection || !downloadList) return;
    downloadSection.style.display = "block";
    downloadList.innerHTML = "";

    if (results.length > 1) {
      const zipItem = document.createElement("div");
      zipItem.className = "download-item download-all-item";
      const infoDiv = document.createElement("div");
      infoDiv.className = "download-item-info";
      const totalSizeMB = (
        results.reduce((sum, r) => sum + r.size, 0) /
        (1024 * 1024)
      ).toFixed(2);
      infoDiv.innerHTML = `
        <div class="zip-header">
          <span class="zip-icon">📦</span>
          <strong>Descargar todos los archivos</strong>
        </div>
        <small>${results.length} archivo(s) PDF • ${totalSizeMB} MB total</small>
      `;
      const downloadDiv = document.createElement("div");
      const zipButton = document.createElement("button");
      zipButton.textContent = "Descargar todo (.ZIP)";
      zipButton.className = "download-zip-btn";
      zipButton.onclick = () => this.downloadAllAsZip(results);
      downloadDiv.appendChild(zipButton);
      zipItem.appendChild(infoDiv);
      zipItem.appendChild(downloadDiv);
      downloadList.appendChild(zipItem);

      const separator = document.createElement("hr");
      separator.className = "download-separator";
      downloadList.appendChild(separator);
    }

    results.sort((a, b) => {
      const typeOrder = { triple: 1, doble: 2, simple: 3 };
      const aOrder = typeOrder[a.type] || 99;
      const bOrder = typeOrder[b.type] || 99;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return (
        (a.tripleNumber || a.dobleNumber || a.simpleNumber || 0) -
        (b.tripleNumber || b.dobleNumber || b.simpleNumber || 0)
      );
    });

    results.forEach((result) => {
      const item = document.createElement("div");
      item.className = "download-item";
      const infoDiv = document.createElement("div");
      infoDiv.className = "download-item-info";
      let typeLabel = "",
        icon = "📄";
      if (result.type === "triple") {
        typeLabel = `Triple ${result.tripleNumber}`;
        icon = "🔢";
      } else if (result.type === "doble") {
        typeLabel = `Doble ${result.dobleNumber}`;
        icon = "🔄";
      } else if (result.type === "simple") {
        typeLabel = `Simple ${result.simpleNumber || result.fileNumber || ""}`;
      }
      const fileSizeKB = Math.round(result.size / 1024);
      infoDiv.innerHTML = `
        <strong>${icon} ${escapeHTML(result.filename)}</strong>
        <small>${escapeHTML(typeLabel)} | ${result.files.length} archivo(s) fuente | ${fileSizeKB} KB</small>
        <div class="file-list">${result.files.map((f) => escapeHTML(f)).join(", ")}</div>
      `;
      const downloadDiv = document.createElement("div");
      const link = this.createDownloadLink(result.filename, result.blob);
      downloadDiv.appendChild(link);
      item.appendChild(infoDiv);
      item.appendChild(downloadDiv);
      downloadList.appendChild(item);
    });

    downloadSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async downloadAllAsZip(results) {
    try {
      this.updateStatus("Creando archivo ZIP...", "processing");
      await this.loadScript(
        "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
      );
      if (typeof JSZip === "undefined")
        throw new Error("No se pudo cargar la biblioteca ZIP");
      const zip = new JSZip();
      results.forEach((result) => zip.file(result.filename, result.blob));
      const zipBlob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });
      const timestamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, "-");
      const url = URL.createObjectURL(zipBlob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `pdfs-procesados-${timestamp}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => {
        URL.revokeObjectURL(url);
        this.updateStatus(
          `¡ZIP descargado con ${results.length} archivos!`,
          "success",
        );
      }, 100);
    } catch (error) {
      console.error("Error al crear ZIP:", error);
      this.updateStatus(
        "No se pudo crear el ZIP. Por favor, descargá los archivos individualmente haciendo clic en los enlaces de abajo.",
        "error",
      );
    }
  }

  loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) {
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Failed to load: ${src}`));
      document.head.appendChild(script);
    });
  }
}

window.pdfProcessor = new PDFProcessor();
