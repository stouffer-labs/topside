import Foundation
import CoreImage
import MLX
import MLXVLM
import MLXLMCommon
import MLXEmbedders

/// Singleton inference engine wrapping mlx-swift-lm for vision-language model inference.
/// Exposed to ObjC via @objc for bridging to the N-API addon layer.
@objc public class MLXInferenceEngine: NSObject {

    @objc public static let shared = MLXInferenceEngine()

    private var modelContainer: MLXLMCommon.ModelContainer?
    private var currentModelId: String?

    // Embedding model (separate from VLM)
    private var embeddingContainer: MLXEmbedders.ModelContainer?
    private var embeddingModelId: String?

    private override init() {
        super.init()
    }

    // MARK: - Model Loading

    @objc public func loadModel(
        _ modelId: String,
        progress: @escaping (Float, String) -> Void,
        completion: @escaping (NSError?) -> Void
    ) {
        // Already loaded
        if currentModelId == modelId && modelContainer != nil {
            completion(nil)
            return
        }

        // Unload previous
        modelContainer = nil
        currentModelId = nil

        Task {
            do {
                let configuration = MLXLMCommon.ModelConfiguration(id: modelId)

                let container = try await VLMModelFactory.shared.loadContainer(
                    configuration: configuration
                ) { p in
                    let fraction = Float(p.fractionCompleted)
                    let message = p.localizedDescription ?? "Downloading..."
                    progress(fraction, message)
                }

                self.modelContainer = container
                self.currentModelId = modelId
                completion(nil)
            } catch {
                let nsError = NSError(
                    domain: "MLXInference",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: error.localizedDescription]
                )
                completion(nsError)
            }
        }
    }

    // MARK: - Generation

    @objc public func generate(
        _ prompt: String,
        imageData: Data?,
        systemPrompt: String?,
        maxTokens: Int,
        onToken: @escaping (String) -> Void,
        completion: @escaping (String?, NSError?) -> Void
    ) {
        guard let container = self.modelContainer else {
            let err = NSError(
                domain: "MLXInference",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Model not loaded"]
            )
            completion(nil, err)
            return
        }

        Task {
            do {
                // Build chat messages
                var messages: [Chat.Message] = []

                if let sys = systemPrompt, !sys.isEmpty {
                    messages.append(.system(sys))
                }

                // Build user message with optional image
                var images: [UserInput.Image] = []
                if let imgData = imageData {
                    if let ciImage = CIImage(data: imgData) {
                        images.append(.ciImage(ciImage))
                    }
                }

                messages.append(.user(prompt, images: images))

                // Create input and prepare
                let userInput = UserInput(chat: messages)
                let lmInput = try await container.prepare(input: userInput)

                // Generate with streaming
                let parameters = GenerateParameters(
                    maxTokens: maxTokens,
                    temperature: 0.1
                )

                var fullText = ""
                let stream = try await container.generate(
                    input: lmInput,
                    parameters: parameters
                )

                for await generation in stream {
                    switch generation {
                    case .chunk(let text):
                        fullText += text
                        onToken(fullText)
                    case .info:
                        break
                    case .toolCall:
                        break
                    }
                }

                completion(fullText, nil)
            } catch {
                let nsError = NSError(
                    domain: "MLXInference",
                    code: 3,
                    userInfo: [NSLocalizedDescriptionKey: error.localizedDescription]
                )
                completion(nil, nsError)
            }
        }
    }

    // MARK: - Embedding

    @objc public func loadEmbeddingModel(
        _ modelId: String,
        progress: @escaping (Float, String) -> Void,
        completion: @escaping (NSError?) -> Void
    ) {
        // Already loaded
        if embeddingModelId == modelId && embeddingContainer != nil {
            completion(nil)
            return
        }

        // Unload previous
        embeddingContainer = nil
        embeddingModelId = nil

        Task {
            do {
                let configuration = MLXEmbedders.ModelConfiguration(id: modelId)
                let container = try await MLXEmbedders.loadModelContainer(
                    configuration: configuration
                ) { p in
                    let fraction = Float(p.fractionCompleted)
                    let message = p.localizedDescription ?? "Downloading..."
                    progress(fraction, message)
                }

                self.embeddingContainer = container
                self.embeddingModelId = modelId
                completion(nil)
            } catch {
                let nsError = NSError(
                    domain: "MLXInference",
                    code: 4,
                    userInfo: [NSLocalizedDescriptionKey: error.localizedDescription]
                )
                completion(nsError)
            }
        }
    }

    @objc public func embed(
        _ text: String,
        completion: @escaping ([NSNumber]?, NSError?) -> Void
    ) {
        guard let container = self.embeddingContainer else {
            let err = NSError(
                domain: "MLXInference",
                code: 5,
                userInfo: [NSLocalizedDescriptionKey: "Embedding model not loaded"]
            )
            completion(nil, err)
            return
        }

        Task {
            let floats: [Float] = await container.perform { model, tokenizer, pooler in
                let tokens = tokenizer.encode(text: text)
                let inputIds = MLXArray(tokens).expandedDimensions(axis: 0)
                let mask = MLXArray.ones(like: inputIds)

                let output = model(inputIds, positionIds: nil, tokenTypeIds: nil, attentionMask: mask)
                let pooled = pooler(output, mask: mask, normalize: true)

                eval(pooled)
                return pooled.squeezed().asArray(Float.self)
            }

            let boxed = floats.map { NSNumber(value: $0) }
            completion(boxed, nil)
        }
    }

    @objc public func unloadEmbeddingModel() {
        embeddingContainer = nil
        embeddingModelId = nil
    }

    @objc public func isEmbeddingLoaded() -> Bool {
        return embeddingContainer != nil
    }

    @objc public func currentEmbeddingModel() -> String? {
        return embeddingModelId
    }

    // MARK: - Lifecycle

    @objc public func unload() {
        modelContainer = nil
        currentModelId = nil
    }

    @objc public func isLoaded() -> Bool {
        return modelContainer != nil
    }

    @objc public func currentModel() -> String? {
        return currentModelId
    }
}
