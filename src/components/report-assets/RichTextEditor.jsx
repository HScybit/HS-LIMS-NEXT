'use client';

import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ReportImageUploadAdapter } from './image-upload.js';
import "./rich-text-editor.scss";

const CKEDITOR_SCRIPT_ID = "athena-ckeditor5-umd";
const CKEDITOR_SCRIPT_SRC = "/ckeditor/ckeditor5.umd.js";
const CKEDITOR_STYLESHEETS = [
  "/ckeditor/ckeditor5.css",
  "/ckeditor/ckeditor5-editor.css",
  "/ckeditor/ckeditor5-content.css",
];

let ckeditorLoadPromise;

export function loadStylesheet(href) {
  if (typeof document === "undefined") return;
  if (document.querySelector(`link[href="${href}"]`)) return;

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.athenaRichTextEditor = "true";
  document.head.appendChild(link);
}

function loadCkeditor() {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("CKEditor can only be loaded in the browser."));
  }

  CKEDITOR_STYLESHEETS.forEach(loadStylesheet);

  if (window.CKEDITOR?.ClassicEditor) {
    return Promise.resolve(window.CKEDITOR);
  }

  if (!ckeditorLoadPromise) {
    ckeditorLoadPromise = new Promise((resolve, reject) => {
      const existingScript = document.getElementById(CKEDITOR_SCRIPT_ID);

      if (existingScript) {
        existingScript.addEventListener("load", () => resolve(window.CKEDITOR));
        existingScript.addEventListener("error", () => reject(new Error("Unable to load CKEditor.")));
        return;
      }

      const script = document.createElement("script");
      script.id = CKEDITOR_SCRIPT_ID;
      script.src = CKEDITOR_SCRIPT_SRC;
      script.async = true;
      script.onload = () => {
        if (window.CKEDITOR?.ClassicEditor) {
          resolve(window.CKEDITOR);
          return;
        }

        reject(new Error("CKEditor loaded without exposing ClassicEditor."));
      };
      script.onerror = () => reject(new Error("Unable to load CKEditor."));
      document.body.appendChild(script);
    });
  }

  return ckeditorLoadPromise;
}

function pickPlugins(ckeditor, names) {
  return names.map((name) => ckeditor[name]).filter(Boolean);
}

function resolveLicenseKey() {
  return "GPL";
}

function createProjectFileUploadPlugin() {
  return function ReportImageUploadPlugin(editor) {
    editor.plugins.get("FileRepository").createUploadAdapter = (loader) =>
      new ReportImageUploadAdapter(loader);
  };
}

function getToolbarItems(toolbarPreset) {
  if (toolbarPreset === "compact") {
    return [
      "heading",
      "|",
      "bold",
      "italic",
      "underline",
      "removeFormat",
      "|",
      "fontSize",
      "fontColor",
      "fontBackgroundColor",
      "|",
      "alignment",
      "bulletedList",
      "numberedList",
      "|",
      "link",
      "insertImage",
      "insertTable",
      "|",
      "undo",
      "redo",
    ];
  }

  return [
    "heading",
    "|",
    "bold",
    "italic",
    "underline",
    "strikethrough",
    "subscript",
    "superscript",
    "removeFormat",
    "|",
    "fontFamily",
    "fontSize",
    "fontColor",
    "fontBackgroundColor",
    "highlight",
    "|",
    "alignment",
    "bulletedList",
    "numberedList",
    "outdent",
    "indent",
    "|",
    "link",
    "insertImage",
    "insertTable",
    "horizontalLine",
    "pageBreak",
    "mediaEmbed",
    "|",
    "findAndReplace",
    "sourceEditing",
    "|",
    "undo",
    "redo",
  ];
}

function buildEditorConfig(ckeditor, {
  placeholder,
  toolbarPreset,
}) {
  return {
    licenseKey: resolveLicenseKey(),
    plugins: pickPlugins(ckeditor, [
      "Essentials",
      "Clipboard",
      "Typing",
      "Paragraph",
      "Heading",
      "Bold",
      "Italic",
      "Underline",
      "Strikethrough",
      "Subscript",
      "Superscript",
      "RemoveFormat",
      "Link",
      "AutoLink",
      "List",
      "ListProperties",
      "Alignment",
      "Indent",
      "IndentBlock",
      "BlockQuote",
      "Font",
      "FontFamily",
      "FontSize",
      "FontColor",
      "FontBackgroundColor",
      "Highlight",
      "Image",
      "ImageUpload",
      "ImageInsert",
      "ImageInsertViaUrl",
      "AutoImage",
      "ImageToolbar",
      "ImageCaption",
      "ImageStyle",
      "ImageResize",
      "ImageTextAlternative",
      "LinkImage",
      "Table",
      "TableToolbar",
      "TableProperties",
      "TableCellProperties",
      "TableCaption",
      "TableColumnResize",
      "MediaEmbed",
      "FindAndReplace",
      "GeneralHtmlSupport",
      "SourceEditing",
      "PasteFromOffice",
      "SpecialCharacters",
      "SpecialCharactersEssentials",
      "HorizontalLine",
      "PageBreak",
      "SelectAll",
      "Undo",
    ]),
    extraPlugins: [createProjectFileUploadPlugin()],
    placeholder,
    toolbar: {
      items: getToolbarItems(toolbarPreset),
      shouldNotGroupWhenFull: false,
    },
    heading: {
      options: [
        { model: "paragraph", title: "Paragraph", class: "ck-heading_paragraph" },
        { model: "heading1", view: "h1", title: "Heading 1", class: "ck-heading_heading1" },
        { model: "heading2", view: "h2", title: "Heading 2", class: "ck-heading_heading2" },
        { model: "heading3", view: "h3", title: "Heading 3", class: "ck-heading_heading3" },
      ],
    },
    fontFamily: {
      supportAllValues: true,
    },
    fontSize: {
      options: [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36],
      supportAllValues: true,
    },
    htmlSupport: {
      allow: [
        {
          name: /.*/,
          attributes: true,
          classes: true,
          styles: true,
        },
      ],
    },
    image: {
      upload: { types: ["jpeg", "png", "webp", "svg+xml"] },
      insert: {
        integrations: ["upload", "url"],
      },
      resizeUnit: "%",
      toolbar: [
        "imageTextAlternative",
        "toggleImageCaption",
        "|",
        "imageStyle:inline",
        "imageStyle:block",
        "imageStyle:side",
        "|",
        "resizeImage",
        "linkImage",
      ],
    },
    list: {
      properties: {
        styles: true,
        startIndex: true,
        reversed: true,
      },
    },
    link: {
      decorators: {
        openInNewTab: {
          mode: "manual",
          label: "Open in a new tab",
          attributes: {
            target: "_blank",
            rel: "noopener noreferrer",
          },
        },
      },
    },
    table: {
      contentToolbar: [
        "tableColumn",
        "tableRow",
        "mergeTableCells",
        "toggleTableCaption",
        "tableProperties",
        "tableCellProperties",
      ],
    },
  };
}

function RichTextEditor(
  {
    value = "",
    onChange,
    onBlur,
    disabled = false,
    placeholder = "Enter content",
    minHeight = 260,
    className = "",
    variant = "default",
    toolbarPreset = "full",
    onPendingChange,
  },
  ref,
) {
  const hostRef = useRef(null);
  const editorRef = useRef(null);
  const lastValueRef = useRef(value || "");
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  const disabledRef = useRef(disabled);
  const pendingChangeRef = useRef(onPendingChange);
  const [loadError, setLoadError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  const editorStyle = useMemo(() => ({ "--rich-text-editor-min-height": `${minHeight}px` }), [minHeight]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onBlurRef.current = onBlur;
  }, [onBlur]);

  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);

  useEffect(() => {
    pendingChangeRef.current = onPendingChange;
  }, [onPendingChange]);

  useImperativeHandle(ref, () => ({
    focus() {
      editorRef.current?.editing?.view?.focus?.();
    },
    getData() {
      return editorRef.current?.getData?.() || lastValueRef.current || "";
    },
    hasPendingActions() {
      return editorRef.current?.plugins?.get('PendingActions')?.hasAny ?? false;
    },
    setData(nextValue = "") {
      const editor = editorRef.current;
      lastValueRef.current = nextValue;
      if (editor && editor.getData() !== nextValue) {
        editor.setData(nextValue);
      }
      onChangeRef.current?.(nextValue);
    },
    insertHtml(html = "") {
      const editor = editorRef.current;
      if (!editor || !html) return false;

      const viewFragment = editor.data.processor.toView(html);
      const modelFragment = editor.data.toModel(viewFragment);
      editor.model.insertContent(modelFragment);
      editor.editing.view.focus();
      return true;
    },
  }), []);

  useEffect(() => {
    let disposed = false;
    let instance;

    loadCkeditor()
      .then((ckeditor) => {
        if (disposed || !hostRef.current) return null;

        return ckeditor.ClassicEditor.create(
          hostRef.current,
          buildEditorConfig(ckeditor, {
            placeholder,
            toolbarPreset,
          }),
        );
      })
      .then((editor) => {
        if (!editor || disposed) {
          void editor?.destroy?.().catch(() => {});
          return;
        }

        instance = editor;
        editorRef.current = editor;
        editor.plugins.get('PendingActions').on('change:hasAny', (_event, _name, value) => pendingChangeRef.current?.(value));
        const initialData = lastValueRef.current || "";
        if (initialData) {
          editor.setData(initialData);
        }

        editor.model.document.on("change:data", () => {
          const data = editor.getData();
          lastValueRef.current = data;
          onChangeRef.current?.(data);
        });

        editor.editing.view.document.on("blur", () => {
          onBlurRef.current?.(editor.getData());
        });

        if (disabledRef.current) {
          editor.enableReadOnlyMode("athena-rich-text-editor");
        }

        setIsLoading(false);
      })
      .catch((error) => {
        if (!disposed) {
          setLoadError(error.message || "Unable to load rich text editor.");
          setIsLoading(false);
        }
      });

    return () => {
      disposed = true;
      editorRef.current = null;
      void instance?.destroy?.().catch(() => {});
    };
  }, [placeholder, toolbarPreset]);

  useEffect(() => {
    const editor = editorRef.current;
    const nextValue = value || "";
    if (!editor || nextValue === lastValueRef.current || nextValue === editor.getData()) return;

    editor.setData(nextValue);
    lastValueRef.current = nextValue;
  }, [value]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    if (disabled) {
      editor.enableReadOnlyMode("athena-rich-text-editor");
    } else {
      editor.disableReadOnlyMode("athena-rich-text-editor");
    }
  }, [disabled]);

  return (
    <div
      className={[
        "rich-text-editor",
        `rich-text-editor--${variant}`,
        isLoading ? "is-loading" : "",
        className,
      ].filter(Boolean).join(" ")}
      style={editorStyle}
    >
      {loadError ? (
        <div className="rich-text-editor__fallback">
          <textarea
            className="form-control"
            rows={8}
            value={value || ""}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(event) => onChange?.(event.currentTarget.value)}
            onBlur={(event) => onBlur?.(event.currentTarget.value)}
          />
          <div className="rich-text-editor__error">{loadError}</div>
        </div>
      ) : (
        <>
          {isLoading ? (
            <div className="rich-text-editor__loading" role="status">
              <span className="rich-text-editor__loading-bar" />
              <span className="rich-text-editor__loading-body" />
            </div>
          ) : null}
          <div ref={hostRef} className="rich-text-editor__host" />
        </>
      )}
    </div>
  );
}

export default forwardRef(RichTextEditor);
