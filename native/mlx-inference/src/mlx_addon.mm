#import <napi.h>
#import <Foundation/Foundation.h>
#import "MLXBridge.h"

// ─── loadModel(modelId, progressCallback) → Promise ────────────────────────────

static Napi::Value LoadModel(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsFunction()) {
        Napi::TypeError::New(env, "Expected (modelId: string, progressCb: function)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string modelId = info[0].As<Napi::String>().Utf8Value();
    Napi::Function progressCb = info[1].As<Napi::Function>();

    // Create thread-safe function for progress callbacks from background thread
    auto tsfn = Napi::ThreadSafeFunction::New(
        env, progressCb, "mlx_progress", 0, 1);

    auto deferred = Napi::Promise::Deferred::New(env);

    NSDictionary *options = @{@"modelId": [NSString stringWithUTF8String:modelId.c_str()]};

    // Release the main thread — all callbacks come back via thread-safe functions
    auto tsfnPtr = new Napi::ThreadSafeFunction(tsfn);
    auto deferredPtr = new Napi::Promise::Deferred(deferred);

    [MLXBridge loadModel:options
        progress:^(NSDictionary *progress) {
            auto callback = [progress](Napi::Env env, Napi::Function fn) {
                Napi::Object obj = Napi::Object::New(env);
                NSNumber *percent = progress[@"percent"];
                NSString *message = progress[@"message"];
                if (percent) obj.Set("percent", Napi::Number::New(env, [percent doubleValue]));
                if (message) obj.Set("message", Napi::String::New(env, [message UTF8String]));
                fn.Call({obj});
            };
            tsfnPtr->BlockingCall(callback);
        }
        completion:^(NSDictionary * _Nullable result, NSError * _Nullable error) {
            if (error) {
                auto callback = [error, deferredPtr, tsfnPtr](Napi::Env env, Napi::Function) {
                    deferredPtr->Reject(Napi::Error::New(env,
                        [[error localizedDescription] UTF8String]).Value());
                    delete deferredPtr;
                    tsfnPtr->Release();
                    delete tsfnPtr;
                };
                tsfnPtr->BlockingCall(callback);
            } else {
                auto callback = [deferredPtr, tsfnPtr](Napi::Env env, Napi::Function) {
                    deferredPtr->Resolve(env.Undefined());
                    delete deferredPtr;
                    tsfnPtr->Release();
                    delete tsfnPtr;
                };
                tsfnPtr->BlockingCall(callback);
            }
        }];

    return deferred.Promise();
}

// ─── generate(options, tokenCallback) → Promise<string> ────────────────────────

static Napi::Value Generate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
        Napi::TypeError::New(env, "Expected (options: object, tokenCb: function)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Object opts = info[0].As<Napi::Object>();
    Napi::Function tokenCb = info[1].As<Napi::Function>();

    // Extract JS options → NSDictionary
    NSMutableDictionary *options = [NSMutableDictionary dictionary];

    if (opts.Has("prompt") && opts.Get("prompt").IsString()) {
        options[@"prompt"] = [NSString stringWithUTF8String:
            opts.Get("prompt").As<Napi::String>().Utf8Value().c_str()];
    }
    if (opts.Has("imageBase64") && opts.Get("imageBase64").IsString()) {
        options[@"imageBase64"] = [NSString stringWithUTF8String:
            opts.Get("imageBase64").As<Napi::String>().Utf8Value().c_str()];
    }
    if (opts.Has("systemPrompt") && opts.Get("systemPrompt").IsString()) {
        options[@"systemPrompt"] = [NSString stringWithUTF8String:
            opts.Get("systemPrompt").As<Napi::String>().Utf8Value().c_str()];
    }
    if (opts.Has("maxTokens") && opts.Get("maxTokens").IsNumber()) {
        options[@"maxTokens"] = @(opts.Get("maxTokens").As<Napi::Number>().Int32Value());
    }

    auto tsfn = Napi::ThreadSafeFunction::New(
        env, tokenCb, "mlx_token", 0, 1);

    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfnPtr = new Napi::ThreadSafeFunction(tsfn);
    auto deferredPtr = new Napi::Promise::Deferred(deferred);

    [MLXBridge generate:options
        onToken:^(NSString *text) {
            // Copy the string before capturing
            std::string cppText = [text UTF8String] ?: "";
            auto callback = [cppText](Napi::Env env, Napi::Function fn) {
                fn.Call({Napi::String::New(env, cppText)});
            };
            tsfnPtr->BlockingCall(callback);
        }
        completion:^(NSString * _Nullable text, NSError * _Nullable error) {
            if (error) {
                auto callback = [error, deferredPtr, tsfnPtr](Napi::Env env, Napi::Function) {
                    deferredPtr->Reject(Napi::Error::New(env,
                        [[error localizedDescription] UTF8String]).Value());
                    delete deferredPtr;
                    tsfnPtr->Release();
                    delete tsfnPtr;
                };
                tsfnPtr->BlockingCall(callback);
            } else {
                std::string resultText = text ? [text UTF8String] : "";
                auto callback = [resultText, deferredPtr, tsfnPtr](Napi::Env env, Napi::Function) {
                    deferredPtr->Resolve(Napi::String::New(env, resultText));
                    delete deferredPtr;
                    tsfnPtr->Release();
                    delete tsfnPtr;
                };
                tsfnPtr->BlockingCall(callback);
            }
        }];

    return deferred.Promise();
}

// ─── unloadModel() ─────────────────────────────────────────────────────────────

static Napi::Value UnloadModel(const Napi::CallbackInfo& info) {
    [MLXBridge unloadModel];
    return info.Env().Undefined();
}

// ─── getStatus() → {loaded, modelId, platform} ────────────────────────────────

static Napi::Value GetStatus(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    NSDictionary *status = [MLXBridge status];

    Napi::Object result = Napi::Object::New(env);
    result.Set("loaded", Napi::Boolean::New(env, [status[@"loaded"] boolValue]));

    if (status[@"modelId"] && ![status[@"modelId"] isKindOfClass:[NSNull class]]) {
        result.Set("modelId", Napi::String::New(env, [status[@"modelId"] UTF8String]));
    } else {
        result.Set("modelId", env.Null());
    }

    result.Set("platform", Napi::String::New(env, [status[@"platform"] UTF8String]));

    return result;
}

// ─── loadEmbeddingModel(modelId, progressCallback) → Promise ────────────────

static Napi::Value LoadEmbeddingModel(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsFunction()) {
        Napi::TypeError::New(env, "Expected (modelId: string, progressCb: function)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string modelId = info[0].As<Napi::String>().Utf8Value();
    Napi::Function progressCb = info[1].As<Napi::Function>();

    auto tsfn = Napi::ThreadSafeFunction::New(
        env, progressCb, "mlx_embed_progress", 0, 1);

    auto deferred = Napi::Promise::Deferred::New(env);
    auto tsfnPtr = new Napi::ThreadSafeFunction(tsfn);
    auto deferredPtr = new Napi::Promise::Deferred(deferred);

    NSDictionary *options = @{@"modelId": [NSString stringWithUTF8String:modelId.c_str()]};

    [MLXBridge loadEmbeddingModel:options
        progress:^(NSDictionary *progress) {
            auto callback = [progress](Napi::Env env, Napi::Function fn) {
                Napi::Object obj = Napi::Object::New(env);
                NSNumber *percent = progress[@"percent"];
                NSString *message = progress[@"message"];
                if (percent) obj.Set("percent", Napi::Number::New(env, [percent doubleValue]));
                if (message) obj.Set("message", Napi::String::New(env, [message UTF8String]));
                fn.Call({obj});
            };
            tsfnPtr->BlockingCall(callback);
        }
        completion:^(NSDictionary * _Nullable result, NSError * _Nullable error) {
            if (error) {
                auto callback = [error, deferredPtr, tsfnPtr](Napi::Env env, Napi::Function) {
                    deferredPtr->Reject(Napi::Error::New(env,
                        [[error localizedDescription] UTF8String]).Value());
                    delete deferredPtr;
                    tsfnPtr->Release();
                    delete tsfnPtr;
                };
                tsfnPtr->BlockingCall(callback);
            } else {
                auto callback = [deferredPtr, tsfnPtr](Napi::Env env, Napi::Function) {
                    deferredPtr->Resolve(env.Undefined());
                    delete deferredPtr;
                    tsfnPtr->Release();
                    delete tsfnPtr;
                };
                tsfnPtr->BlockingCall(callback);
            }
        }];

    return deferred.Promise();
}

// ─── embed(text) → Promise<Float32Array> ────────────────────────────────────

static Napi::Value Embed(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected (text: string)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string text = info[0].As<Napi::String>().Utf8Value();

    auto deferred = Napi::Promise::Deferred::New(env);
    auto deferredPtr = new Napi::Promise::Deferred(deferred);

    // Create a no-op TSFN to marshal the completion back to the JS thread
    Napi::Function noop = Napi::Function::New(env, [](const Napi::CallbackInfo&){});
    auto tsfn = Napi::ThreadSafeFunction::New(env, noop, "mlx_embed", 0, 1);
    auto tsfnPtr = new Napi::ThreadSafeFunction(tsfn);

    NSString *nsText = [NSString stringWithUTF8String:text.c_str()];

    [MLXBridge embed:nsText
        completion:^(NSArray<NSNumber *> * _Nullable embedding, NSError * _Nullable error) {
            if (error) {
                auto callback = [error, deferredPtr, tsfnPtr](Napi::Env env, Napi::Function) {
                    deferredPtr->Reject(Napi::Error::New(env,
                        [[error localizedDescription] UTF8String]).Value());
                    delete deferredPtr;
                    tsfnPtr->Release();
                    delete tsfnPtr;
                };
                tsfnPtr->BlockingCall(callback);
            } else {
                // Copy the float array before the block goes out of scope
                std::vector<float> vec;
                vec.reserve([embedding count]);
                for (NSNumber *n in embedding) {
                    vec.push_back([n floatValue]);
                }
                auto callback = [vec = std::move(vec), deferredPtr, tsfnPtr](Napi::Env env, Napi::Function) {
                    auto buf = Napi::Float32Array::New(env, vec.size());
                    memcpy(buf.Data(), vec.data(), vec.size() * sizeof(float));
                    deferredPtr->Resolve(buf);
                    delete deferredPtr;
                    tsfnPtr->Release();
                    delete tsfnPtr;
                };
                tsfnPtr->BlockingCall(callback);
            }
        }];

    return deferred.Promise();
}

// ─── unloadEmbeddingModel() ─────────────────────────────────────────────────

static Napi::Value UnloadEmbeddingModel(const Napi::CallbackInfo& info) {
    [MLXBridge unloadEmbeddingModel];
    return info.Env().Undefined();
}

// ─── embeddingStatus() → {loaded, modelId} ─────────────────────────────────

static Napi::Value EmbeddingStatus(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    NSDictionary *status = [MLXBridge embeddingStatus];

    Napi::Object result = Napi::Object::New(env);
    result.Set("loaded", Napi::Boolean::New(env, [status[@"loaded"] boolValue]));

    if (status[@"modelId"] && ![status[@"modelId"] isKindOfClass:[NSNull class]]) {
        result.Set("modelId", Napi::String::New(env, [status[@"modelId"] UTF8String]));
    } else {
        result.Set("modelId", env.Null());
    }

    return result;
}

// ─── Module Init ───────────────────────────────────────────────────────────────

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("loadModel", Napi::Function::New(env, LoadModel));
    exports.Set("generate", Napi::Function::New(env, Generate));
    exports.Set("unloadModel", Napi::Function::New(env, UnloadModel));
    exports.Set("getStatus", Napi::Function::New(env, GetStatus));
    exports.Set("loadEmbeddingModel", Napi::Function::New(env, LoadEmbeddingModel));
    exports.Set("embed", Napi::Function::New(env, Embed));
    exports.Set("unloadEmbeddingModel", Napi::Function::New(env, UnloadEmbeddingModel));
    exports.Set("embeddingStatus", Napi::Function::New(env, EmbeddingStatus));
    return exports;
}

NODE_API_MODULE(mlx_inference, Init)
