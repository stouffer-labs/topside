{
  "targets": [
    {
      "target_name": "build_swift",
      "type": "none",
      "actions": [
        {
          "action_name": "build_swift_package",
          "inputs": [
            "swift-bridge/Package.swift",
            "swift-bridge/Sources/MLXInferenceEngine.swift"
          ],
          "outputs": [
            "<(PRODUCT_DIR)/libMLXInferenceBridge.a"
          ],
          "action": [
            "bash", "-c",
            "export SDKROOT=$(xcrun --sdk macosx --show-sdk-path) && cd swift-bridge && swift build -c release --arch arm64 && cp .build/release/libMLXInferenceBridge.a \"<(PRODUCT_DIR)/libMLXInferenceBridge.a\" && cp .build/arm64-apple-macosx/release/MLXInferenceBridge.build/MLXInferenceBridge-Swift.h \"<(PRODUCT_DIR)/MLXInferenceBridge-Swift.h\" && cd .. && bash build-metallib.sh \"<(PRODUCT_DIR)\""
          ]
        }
      ]
    },
    {
      "target_name": "mlx_inference",
      "dependencies": ["build_swift"],
      "sources": [
        "src/mlx_addon.mm",
        "src/MLXBridge.m"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "include",
        "<(PRODUCT_DIR)"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "xcode_settings": {
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "OTHER_CPLUSPLUSFLAGS": ["-ObjC++", "-std=c++17"],
        "MACOSX_DEPLOYMENT_TARGET": "14.0",
        "OTHER_LDFLAGS": [
          "-L<(PRODUCT_DIR)",
          "-lMLXInferenceBridge",
          "-L/usr/lib/swift",
          "-Wl,-rpath,/usr/lib/swift"
        ]
      },
      "link_settings": {
        "libraries": [
          "-framework Foundation",
          "-framework Metal",
          "-framework MetalPerformanceShaders",
          "-framework MetalPerformanceShadersGraph",
          "-framework Accelerate",
          "-framework CoreML",
          "-framework CoreImage",
          "-framework CoreVideo",
          "-framework AVFoundation"
        ]
      }
    }
  ]
}
