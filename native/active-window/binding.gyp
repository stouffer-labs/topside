{
  "targets": [
    {
      "target_name": "active_window",
      "sources": ["src/active_window.mm"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "xcode_settings": {
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "OTHER_CPLUSPLUSFLAGS": ["-ObjC++"],
        "MACOSX_DEPLOYMENT_TARGET": "11.0"
      },
      "link_settings": {
        "libraries": [
          "-framework AppKit",
          "-framework CoreGraphics",
          "-framework Foundation"
        ]
      }
    }
  ]
}
