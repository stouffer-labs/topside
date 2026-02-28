#!/bin/bash
# Compiles MLX Metal shaders into mlx.metallib
# Called by binding.gyp as part of the build process

PRODUCT_DIR="$1"
if [ -z "$PRODUCT_DIR" ]; then
  echo "Usage: build-metallib.sh <PRODUCT_DIR>"
  exit 1
fi

# Skip if metallib already exists (incremental build)
if [ -f "$PRODUCT_DIR/mlx.metallib" ]; then
  echo "mlx.metallib already exists, skipping"
  exit 0
fi

MLX_DIR="swift-bridge/.build/checkouts/mlx-swift/Source/Cmlx"
KERNELS="$MLX_DIR/mlx/mlx/backend/metal/kernels"
MLX_INCLUDE="$MLX_DIR/mlx"
GENERATED="$MLX_DIR/mlx-generated/metal"
BUILD_DIR="swift-bridge/.build/metallib-build"

mkdir -p "$BUILD_DIR"

# Compile generated .metal files (processed versions, take priority)
for f in $(find "$GENERATED" -name "*.metal" 2>/dev/null); do
  name=$(basename "$f" .metal)
  xcrun -sdk macosx metal -x metal -std=metal3.1 -fno-fast-math \
    -c "$f" -I"$MLX_INCLUDE" -I"$KERNELS" \
    -o "$BUILD_DIR/${name}.air" 2>&1 || true
done

# Compile remaining kernel .metal files not already compiled from generated
for f in $(find "$KERNELS" -name "*.metal" -not -path "*/examples/*" 2>/dev/null); do
  name=$(basename "$f" .metal)
  if [ -f "$BUILD_DIR/${name}.air" ]; then
    continue
  fi
  xcrun -sdk macosx metal -x metal -std=metal3.1 -fno-fast-math \
    -c "$f" -I"$MLX_INCLUDE" -I"$KERNELS" \
    -o "$BUILD_DIR/${name}.air" 2>&1 || true
done

# Check we have .air files
AIR_COUNT=$(ls "$BUILD_DIR"/*.air 2>/dev/null | wc -l | tr -d ' ')
if [ "$AIR_COUNT" -eq 0 ]; then
  echo "ERROR: No .air files compiled"
  exit 1
fi

# Link all .air files into metallib
xcrun -sdk macosx metallib "$BUILD_DIR"/*.air -o "$PRODUCT_DIR/mlx.metallib"
if [ $? -ne 0 ]; then
  echo "ERROR: metallib linking failed"
  exit 1
fi

echo "Built mlx.metallib ($AIR_COUNT shaders)"
