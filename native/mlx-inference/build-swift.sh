#!/bin/bash
# Build the Swift package independently (useful for debugging before node-gyp)
set -e
cd "$(dirname "$0")/swift-bridge"
echo "Building MLXInferenceBridge Swift package..."
swift build -c release --arch arm64
echo "Build complete. Library at: .build/release/libMLXInferenceBridge.a"
ls -la .build/release/libMLXInferenceBridge.a
