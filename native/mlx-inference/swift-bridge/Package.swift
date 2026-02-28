// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "MLXInferenceBridge",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "MLXInferenceBridge", type: .static, targets: ["MLXInferenceBridge"]),
    ],
    dependencies: [
        .package(path: "mlx-swift-lm"),
    ],
    targets: [
        .target(
            name: "MLXInferenceBridge",
            dependencies: [
                .product(name: "MLXVLM", package: "mlx-swift-lm"),
                .product(name: "MLXLMCommon", package: "mlx-swift-lm"),
                .product(name: "MLXEmbedders", package: "mlx-swift-lm"),
            ],
            path: "Sources"
        ),
    ]
)
