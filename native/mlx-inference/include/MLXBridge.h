#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// ObjC bridge between Swift MLXInferenceEngine and the C++ N-API addon.
/// Methods accept NSDictionary options and use block callbacks for async results.
@interface MLXBridge : NSObject

/// Load a model from HuggingFace hub.
/// @param options @{@"modelId": NSString}
/// @param progressBlock Called with @{@"percent": NSNumber, @"message": NSString}
/// @param completion Called with (result, error). result is nil on success.
+ (void)loadModel:(NSDictionary *)options
          progress:(void(^)(NSDictionary *progress))progressBlock
        completion:(void(^)(NSDictionary * _Nullable result, NSError * _Nullable error))completion;

/// Run VLM inference.
/// @param options @{@"prompt": NSString, @"imageBase64": NSString (optional),
///                   @"systemPrompt": NSString (optional), @"maxTokens": NSNumber}
/// @param tokenBlock Called with cumulative generated text so far
/// @param completion Called with (fullText, error)
+ (void)generate:(NSDictionary *)options
         onToken:(void(^)(NSString *text))tokenBlock
      completion:(void(^)(NSString * _Nullable text, NSError * _Nullable error))completion;

/// Unload current model from GPU memory.
+ (void)unloadModel;

/// Get current status.
/// @return @{@"loaded": NSNumber(BOOL), @"modelId": NSString or NSNull, @"platform": @"mlx"}
+ (NSDictionary *)status;

/// Load an embedding model from HuggingFace hub.
/// @param options @{@"modelId": NSString}
/// @param progressBlock Called with @{@"percent": NSNumber, @"message": NSString}
/// @param completion Called with (result, error).
+ (void)loadEmbeddingModel:(NSDictionary *)options
                   progress:(void(^)(NSDictionary *progress))progressBlock
                 completion:(void(^)(NSDictionary * _Nullable result, NSError * _Nullable error))completion;

/// Compute embedding vector for text.
/// @param text Input text to embed
/// @param completion Called with (NSArray<NSNumber*> embedding, error)
+ (void)embed:(NSString *)text
   completion:(void(^)(NSArray<NSNumber *> * _Nullable embedding, NSError * _Nullable error))completion;

/// Unload embedding model from memory.
+ (void)unloadEmbeddingModel;

/// Get embedding model status.
/// @return @{@"loaded": NSNumber(BOOL), @"modelId": NSString or NSNull}
+ (NSDictionary *)embeddingStatus;

@end

NS_ASSUME_NONNULL_END
