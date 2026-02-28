#import "MLXBridge.h"

// Swift-generated header — copied to PRODUCT_DIR by the build_swift action
#import "MLXInferenceBridge-Swift.h"

@implementation MLXBridge

+ (void)loadModel:(NSDictionary *)options
          progress:(void(^)(NSDictionary *progress))progressBlock
        completion:(void(^)(NSDictionary * _Nullable result, NSError * _Nullable error))completion {

    NSString *modelId = options[@"modelId"];
    if (!modelId) {
        NSError *err = [NSError errorWithDomain:@"MLXBridge" code:100
                                       userInfo:@{NSLocalizedDescriptionKey: @"modelId is required"}];
        completion(nil, err);
        return;
    }

    [[MLXInferenceEngine shared] loadModel:modelId
        progress:^(float fraction, NSString *message) {
            progressBlock(@{
                @"percent": @(roundf(fraction * 100)),
                @"message": message ?: @""
            });
        }
        completion:^(NSError * _Nullable error) {
            if (error) {
                completion(nil, error);
            } else {
                completion(@{@"status": @"ready"}, nil);
            }
        }];
}

+ (void)generate:(NSDictionary *)options
         onToken:(void(^)(NSString *text))tokenBlock
      completion:(void(^)(NSString * _Nullable text, NSError * _Nullable error))completion {

    NSString *prompt = options[@"prompt"];
    if (!prompt) {
        NSError *err = [NSError errorWithDomain:@"MLXBridge" code:101
                                       userInfo:@{NSLocalizedDescriptionKey: @"prompt is required"}];
        completion(nil, err);
        return;
    }

    // Decode base64 image data if provided
    NSData *imageData = nil;
    NSString *imageBase64 = options[@"imageBase64"];
    if (imageBase64 && [imageBase64 length] > 0) {
        imageData = [[NSData alloc] initWithBase64EncodedString:imageBase64 options:0];
    }

    NSString *systemPrompt = options[@"systemPrompt"];
    if ([systemPrompt isKindOfClass:[NSNull class]]) systemPrompt = nil;

    NSNumber *maxTokensNum = options[@"maxTokens"];
    NSInteger maxTokens = maxTokensNum ? [maxTokensNum integerValue] : 2048;

    [[MLXInferenceEngine shared] generate:prompt
        imageData:imageData
        systemPrompt:systemPrompt
        maxTokens:maxTokens
        onToken:^(NSString *text) {
            tokenBlock(text);
        }
        completion:^(NSString * _Nullable text, NSError * _Nullable error) {
            completion(text, error);
        }];
}

+ (void)unloadModel {
    [[MLXInferenceEngine shared] unload];
}

+ (NSDictionary *)status {
    MLXInferenceEngine *engine = [MLXInferenceEngine shared];
    NSString *modelId = [engine currentModel];
    return @{
        @"loaded": @([engine isLoaded]),
        @"modelId": modelId ?: [NSNull null],
        @"platform": @"mlx"
    };
}

+ (void)loadEmbeddingModel:(NSDictionary *)options
                   progress:(void(^)(NSDictionary *progress))progressBlock
                 completion:(void(^)(NSDictionary * _Nullable result, NSError * _Nullable error))completion {

    NSString *modelId = options[@"modelId"];
    if (!modelId) {
        NSError *err = [NSError errorWithDomain:@"MLXBridge" code:200
                                       userInfo:@{NSLocalizedDescriptionKey: @"modelId is required"}];
        completion(nil, err);
        return;
    }

    [[MLXInferenceEngine shared] loadEmbeddingModel:modelId
        progress:^(float fraction, NSString *message) {
            progressBlock(@{
                @"percent": @(roundf(fraction * 100)),
                @"message": message ?: @""
            });
        }
        completion:^(NSError * _Nullable error) {
            if (error) {
                completion(nil, error);
            } else {
                completion(@{@"status": @"ready"}, nil);
            }
        }];
}

+ (void)embed:(NSString *)text
   completion:(void(^)(NSArray<NSNumber *> * _Nullable embedding, NSError * _Nullable error))completion {

    if (!text) {
        NSError *err = [NSError errorWithDomain:@"MLXBridge" code:201
                                       userInfo:@{NSLocalizedDescriptionKey: @"text is required"}];
        completion(nil, err);
        return;
    }

    [[MLXInferenceEngine shared] embed:text
        completion:^(NSArray<NSNumber *> * _Nullable result, NSError * _Nullable error) {
            completion(result, error);
        }];
}

+ (void)unloadEmbeddingModel {
    [[MLXInferenceEngine shared] unloadEmbeddingModel];
}

+ (NSDictionary *)embeddingStatus {
    MLXInferenceEngine *engine = [MLXInferenceEngine shared];
    NSString *modelId = [engine currentEmbeddingModel];
    return @{
        @"loaded": @([engine isEmbeddingLoaded]),
        @"modelId": modelId ?: [NSNull null],
    };
}

@end
