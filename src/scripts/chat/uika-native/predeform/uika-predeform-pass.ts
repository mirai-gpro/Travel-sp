// UIKA Native Runtime v1.1 — Gate 4B-2A Pre-Deformation PoC
//
// Gate 4B-1 measured, on a real GPU, that the production render shader spends
// 72.06 ms of draw time with the 51-channel basis loop and 37.82 ms without it, and
// that the distance/sort pass evaluates the same 51 channels a second time. The
// animated centre of one A2E frame, however, is one value per Gaussian. This pass
// computes it once per expression frame into a float texture that the render pass and
// the sort pass both read.
//
//   expression weights change
//     -> one pass over 133,541 Gaussians, 51 channels, into animatedCenterTexture
//     -> render  : one texel fetch per Gaussian
//     -> sort    : one texel fetch per Gaussian, the same texture
//
// This is not basis reduction: all 51 channels and all 133,541 Gaussians stay, D_UIKA
// is untouched, the weights are untouched, the mapper is untouched, and the expression
// evaluated here is character for character the production expression.
//
// PoC only. Nothing in this file is reachable from /uika-native-replay,
// /uika-native-benchmark or /uika-native-draw-isolation.

import * as THREE from 'three';

function fail(message: string): never {
    throw new Error(`UIKA predeform: ${message}`);
}

export interface UikaPredeformCapabilities {
    webgl2: boolean;
    colorBufferFloat: boolean;
    maxTextureSize: number;
    maxColorAttachments: number;
    /** Why the pass cannot run, if it cannot. Empty when it can. */
    blockers: string[];
}

export interface UikaPredeformLayout {
    gaussianCount: number;
    basisCount: number;
    textureWidth: number;
    textureHeight: number;
    texels: number;
    /** RGBA32F: four 32-bit floats per texel. */
    bytes: number;
    format: 'RGBA32F';
}

export interface UikaPredeformStats {
    passCount: number;
    weightChangeCount: number;
    lastPassMs: number;
    distanceRuns: number;
    lastDistanceMs: number;
    dirty: boolean;
}

/** The same shape the Gate 4A/4B-1 GPU timer uses, plus the pre-deformation pass. */
export interface UikaPredeformGpuTimer {
    beginPredeform?(): void;
    endPredeform?(): void;
}

/**
 * Gate 4B-2B-0 §4. The fence and the buffer readback live in this pass, so this is where
 * they are timed. Optional and null on every route that does not install a diagnostic.
 */
export interface UikaDistanceLifecycleRecorder {
    fenceWaitStart?(at: number): void;
    fenceWaitEnd?(at: number, polls: number): void;
    readbackStart?(at: number): void;
    readbackEnd?(at: number): void;
}

/**
 * The expression helpers are copied verbatim from the production vertex shader
 * (SplatMaterial.js) so that the value written here is produced by the identical
 * expression, with the identical texture sampling convention, in the identical order.
 */
const PREDEFORM_FRAGMENT = /* glsl */`
precision highp float;
precision highp int;

uniform highp usampler2D centersColorsTexture;
uniform vec2 centersColorsTextureSize;
uniform highp usampler2D uikaBasisTexture;
uniform vec2 uikaBasisTextureSize;
uniform highp usampler2D uikaWeightTexture;
uniform vec2 uikaWeightTextureSize;
uniform int uikaBasisCount;
uniform int uikaGaussianCount;
uniform vec2 uikaOutputSize;

layout(location = 0) out vec4 fragColor;

// verbatim from SplatMaterial.js getDataUV(1, 0, centersColorsTextureSize)
vec2 getCenterUV(in uint sIndex) {
    vec2 samplerUV = vec2(0.0, 0.0);
    float d = float(sIndex * uint(1) + uint(0)) / centersColorsTextureSize.x;
    samplerUV.y = float(floor(d)) / centersColorsTextureSize.y;
    samplerUV.x = fract(d);
    return samplerUV;
}

// verbatim from SplatMaterial.js
vec3 uikaBasisDelta(in int channel, in uint sIndex) {
    float d = float(sIndex + uint(uikaGaussianCount * channel)) / uikaBasisTextureSize.x;
    vec2 uv = vec2(fract(d), floor(d) / uikaBasisTextureSize.y);
    return uintBitsToFloat(texture(uikaBasisTexture, uv).rgb);
}

// verbatim from SplatMaterial.js
float uikaWeight(in int channel) {
    int texel = channel / 4;
    float d = float(texel) / uikaWeightTextureSize.x;
    vec2 uv = vec2(fract(d), floor(d) / uikaWeightTextureSize.y);
    vec4 packed = uintBitsToFloat(texture(uikaWeightTexture, uv));
    int lane = channel - texel * 4;
    if (lane == 1) return packed.g;
    if (lane == 2) return packed.b;
    if (lane == 3) return packed.a;
    return packed.r;
}

void main() {
    int x = int(gl_FragCoord.x);
    int y = int(gl_FragCoord.y);
    int index = y * int(uikaOutputSize.x) + x;
    if (index >= uikaGaussianCount) {
        fragColor = vec4(0.0, 0.0, 0.0, 0.0);
        return;
    }
    uint sIndex = uint(index);

    uvec4 sampledCenterColor = texture(centersColorsTexture, getCenterUV(sIndex));
    vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));

    // animatedCenter(i) = canonicalCenter(i) + sum(k) uikaWeights[k] * D_UIKA[k, i]
    for (int k = 0; k < uikaBasisCount; ++k) {
        splatCenter += uikaWeight(k) * uikaBasisDelta(k, sIndex);
    }

    fragColor = vec4(splatCenter, 1.0);
}
`;

const PREDEFORM_VERTEX = /* glsl */`
precision highp float;
in vec3 position;
void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * The same dot product, in the same order, as the production distance shader in
 * SplatMesh.js — only the source of the animated centre differs.
 */
const DISTANCE_VERTEX = /* glsl */`#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uikaAnimatedCenterTexture;
uniform vec2 uikaAnimatedCenterTextureSize;
uniform vec3 modelViewProj;
flat out float distance;
void main(void) {
    int i = gl_VertexID;
    int w = int(uikaAnimatedCenterTextureSize.x);
    vec3 animatedCenter = texelFetch(uikaAnimatedCenterTexture, ivec2(i % w, i / w), 0).xyz;
    distance = animatedCenter.x * modelViewProj.x +
               animatedCenter.y * modelViewProj.y +
               animatedCenter.z * modelViewProj.z;
}
`;

const DISTANCE_FRAGMENT = /* glsl */`#version 300 es
precision lowp float;
out vec4 fragColor;
void main(){}
`;

export class UikaPredeformPass {
    private renderer: any = null;
    private splatMesh: any = null;
    private gl: WebGL2RenderingContext | null = null;

    private target: any = null;
    private quadScene: any = null;
    private quadCamera: any = null;
    private quadMaterial: any = null;

    private distanceProgram: WebGLProgram | null = null;
    private distanceVao: WebGLVertexArrayObject | null = null;
    private distanceBuffer: WebGLBuffer | null = null;
    private distanceTf: WebGLTransformFeedback | null = null;
    private distanceLocs: {
        modelViewProj: WebGLUniformLocation | null;
        centerTexture: WebGLUniformLocation | null;
        centerTextureSize: WebGLUniformLocation | null;
    } | null = null;
    private syncTimeout: any = null;

    private layout: UikaPredeformLayout | null = null;
    private gpuTimer: UikaPredeformGpuTimer | null = null;
    private distanceLifecycle: UikaDistanceLifecycleRecorder | null = null;
    private dirty = true;
    private stats: UikaPredeformStats = {
        passCount: 0, weightChangeCount: 0, lastPassMs: 0,
        distanceRuns: 0, lastDistanceMs: 0, dirty: true,
    };

    static capabilities(gl: WebGL2RenderingContext | null): UikaPredeformCapabilities {
        const blockers: string[] = [];
        if (!gl) {
            return {
                webgl2: false, colorBufferFloat: false, maxTextureSize: 0, maxColorAttachments: 0,
                blockers: ['no WebGL2 context'],
            };
        }
        const webgl2 = typeof (gl as any).createTransformFeedback === 'function';
        const colorBufferFloat = gl.getExtension('EXT_color_buffer_float') !== null;
        if (!webgl2) blockers.push('WebGL2 is not available');
        if (!colorBufferFloat) {
            blockers.push('EXT_color_buffer_float is unavailable, so an RGBA32F render target '
                + 'cannot be created — the PoC stops rather than lowering the centre precision');
        }
        return {
            webgl2,
            colorBufferFloat,
            maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
            maxColorAttachments: gl.getParameter(gl.MAX_COLOR_ATTACHMENTS),
            blockers,
        };
    }

    getLayout(): UikaPredeformLayout | null { return this.layout; }
    getStats(): UikaPredeformStats { return { ...this.stats, dirty: this.dirty }; }
    getTexture(): any { return this.target ? this.target.texture : null; }
    setGpuTimer(timer: UikaPredeformGpuTimer | null): void { this.gpuTimer = timer; }
    /** Gate 4B-2B-0 diagnostic only. */
    setDistanceLifecycleRecorder(recorder: UikaDistanceLifecycleRecorder | null): void {
        this.distanceLifecycle = recorder;
    }

    resetStats(): void {
        this.stats.passCount = 0;
        this.stats.weightChangeCount = 0;
        this.stats.distanceRuns = 0;
    }

    /** Called whenever the expression weights change. The pass itself runs in the frame. */
    markDirty(): void {
        this.dirty = true;
        this.stats.weightChangeCount++;
    }

    init(handles: { renderer: any; splatMesh: any }): UikaPredeformLayout {
        if (this.target) fail('already initialised');
        this.renderer = handles.renderer;
        this.splatMesh = handles.splatMesh;
        this.gl = this.renderer.getContext();

        const caps = UikaPredeformPass.capabilities(this.gl);
        if (caps.blockers.length > 0) fail(caps.blockers.join('; '));

        const gaussianCount = this.splatMesh.getSplatCount();
        const basisCount = this.splatMesh.uikaBasisCount;
        if (!(gaussianCount > 0)) fail(`gaussianCount=${gaussianCount}`);
        if (!(basisCount > 0)) fail(`the basis is not resident (uikaBasisCount=${basisCount})`);

        const width = Math.min(4096, caps.maxTextureSize);
        const height = Math.ceil(gaussianCount / width);
        if (height > caps.maxTextureSize) fail(`${width}x${height} exceeds MAX_TEXTURE_SIZE`);

        this.target = new THREE.WebGLRenderTarget(width, height, {
            format: THREE.RGBAFormat,
            type: THREE.FloatType,
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            depthBuffer: false,
            stencilBuffer: false,
            generateMipmaps: false,
        });
        this.target.texture.generateMipmaps = false;

        const u = this.splatMesh.material.uniforms;
        this.quadMaterial = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: PREDEFORM_VERTEX,
            fragmentShader: PREDEFORM_FRAGMENT,
            depthTest: false,
            depthWrite: false,
            uniforms: {
                // The very texture objects the production render shader samples.
                centersColorsTexture: { value: u.centersColorsTexture.value },
                centersColorsTextureSize: { value: u.centersColorsTextureSize.value },
                uikaBasisTexture: { value: u.uikaBasisTexture.value },
                uikaBasisTextureSize: { value: u.uikaBasisTextureSize.value },
                uikaWeightTexture: { value: u.uikaWeightTexture.value },
                uikaWeightTextureSize: { value: u.uikaWeightTextureSize.value },
                uikaBasisCount: { value: basisCount },
                uikaGaussianCount: { value: gaussianCount },
                uikaOutputSize: { value: new THREE.Vector2(width, height) },
            },
        });
        this.quadScene = new THREE.Scene();
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.quadMaterial);
        // The positions are already clip space, so no camera transform and no culling.
        quad.frustumCulled = false;
        this.quadScene.add(quad);
        this.quadCamera = new THREE.Camera();

        this.layout = {
            gaussianCount,
            basisCount,
            textureWidth: width,
            textureHeight: height,
            texels: width * height,
            bytes: width * height * 16,
            format: 'RGBA32F',
        };

        this.dirty = true;
        return this.layout;
    }

    /** Run the deformation pass, but only when the weights actually changed. */
    runIfDirty(): boolean {
        if (!this.dirty) return false;
        this.run();
        return true;
    }

    run(): void {
        if (!this.target) fail('init() has not run');
        const started = performance.now();
        this.gpuTimer?.beginPredeform?.();
        const previousTarget = this.renderer.getRenderTarget();
        this.renderer.setRenderTarget(this.target);
        this.renderer.render(this.quadScene, this.quadCamera);
        this.renderer.setRenderTarget(previousTarget);
        this.gpuTimer?.endPredeform?.();
        this.dirty = false;
        this.stats.passCount++;
        this.stats.lastPassMs = performance.now() - started;
    }

    /** Correctness only: the animated centres as the GPU wrote them. */
    readAnimatedCenters(): Float32Array {
        if (!this.target || !this.layout) fail('init() has not run');
        const { textureWidth: w, textureHeight: h } = this.layout;
        const buffer = new Float32Array(w * h * 4);
        this.renderer.readRenderTargetPixels(this.target, 0, 0, w, h, buffer);
        return buffer;
    }

    private initDistanceProgram(): void {
        const gl = this.gl!;
        const compile = (type: number, source: string): WebGLShader => {
            const shader = gl.createShader(type);
            if (!shader) fail('could not create a shader object');
            gl.shaderSource(shader!, source);
            gl.compileShader(shader!);
            if (!gl.getShaderParameter(shader!, gl.COMPILE_STATUS)) {
                const log = gl.getShaderInfoLog(shader!);
                gl.deleteShader(shader!);
                fail(`distance shader failed to compile: ${log}`);
            }
            return shader!;
        };

        const program = gl.createProgram();
        if (!program) fail('could not create the distance program');
        const vs = compile(gl.VERTEX_SHADER, DISTANCE_VERTEX);
        const fs = compile(gl.FRAGMENT_SHADER, DISTANCE_FRAGMENT);
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.transformFeedbackVaryings(program, ['distance'], gl.SEPARATE_ATTRIBS);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            fail(`distance program failed to link: ${gl.getProgramInfoLog(program)}`);
        }

        this.distanceProgram = program;
        this.distanceVao = gl.createVertexArray();
        this.distanceTf = gl.createTransformFeedback();
        this.distanceBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.distanceBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.layout!.gaussianCount * 4, gl.STATIC_READ);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        this.distanceLocs = {
            modelViewProj: gl.getUniformLocation(program, 'modelViewProj'),
            centerTexture: gl.getUniformLocation(program, 'uikaAnimatedCenterTexture'),
            centerTextureSize: gl.getUniformLocation(program, 'uikaAnimatedCenterTextureSize'),
        };
    }

    /**
     * The GL name of the render target's texture. three.js owns the object; the
     * transform-feedback pass is raw GL and needs the handle. If three.js has not
     * created it yet, or the internal table is not reachable, the PoC stops — it never
     * silently falls back to the production 51-channel distance shader, because then the
     * measurement would be of something else entirely.
     */
    private animatedCenterGlTexture(): WebGLTexture {
        const properties = this.renderer.properties;
        if (!properties || typeof properties.get !== 'function') {
            fail('three.js renderer.properties is not reachable, so the pre-deformed centre '
                + 'texture cannot be bound to the raw-GL distance pass');
        }
        const entry = properties.get(this.target.texture);
        const handle = entry && entry.__webglTexture;
        if (!handle) {
            fail('the pre-deformed centre texture has no GL name yet; the deformation pass '
                + 'must run once before the distance pass');
        }
        return handle as WebGLTexture;
    }

    /**
     * Depth keys from the pre-deformed centres. Mirrors
     * `SplatMesh.computeDistancesOnGPU`: transform feedback over POINTS, a fence, then
     * getBufferSubData — so a production-vs-PoC sort comparison differs only in where the
     * animated centre comes from.
     */
    computeDistances = (() => {
        return (modelViewProjMatrix: any, outComputedDistances: Float32Array): Promise<void> => {
            if (!this.target) fail('init() has not run');
            if (this.dirty) this.run();
            if (!this.distanceProgram) this.initDistanceProgram();
            const gl = this.gl!;
            const started = performance.now();

            const previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
            const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM);
            const previousProgramDeleted = previousProgram
                ? gl.getProgramParameter(previousProgram, gl.DELETE_STATUS) : false;
            const previousActiveUnit = gl.getParameter(gl.ACTIVE_TEXTURE);
            gl.activeTexture(gl.TEXTURE0);
            const previousUnit0 = gl.getParameter(gl.TEXTURE_BINDING_2D);

            gl.bindVertexArray(this.distanceVao);
            gl.useProgram(this.distanceProgram);
            gl.enable(gl.RASTERIZER_DISCARD);

            const e = modelViewProjMatrix.elements;
            gl.uniform3f(this.distanceLocs!.modelViewProj, e[2], e[6], e[10]);
            gl.bindTexture(gl.TEXTURE_2D, this.animatedCenterGlTexture());
            gl.uniform1i(this.distanceLocs!.centerTexture, 0);
            gl.uniform2f(this.distanceLocs!.centerTextureSize,
                         this.layout!.textureWidth, this.layout!.textureHeight);

            gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.distanceTf);
            gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.distanceBuffer);
            gl.beginTransformFeedback(gl.POINTS);
            gl.drawArrays(gl.POINTS, 0, this.layout!.gaussianCount);
            gl.endTransformFeedback();
            gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
            gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
            gl.disable(gl.RASTERIZER_DISCARD);

            // Put three.js's texture-unit state back exactly as it was; the renderer
            // caches it and a stale unit shows up as a smeared avatar.
            gl.bindTexture(gl.TEXTURE_2D, previousUnit0);
            gl.activeTexture(previousActiveUnit);

            const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            gl.flush();
            this.distanceLifecycle?.fenceWaitStart?.(performance.now());

            const promise = new Promise<void>((resolve) => {
                let polls = 0;
                const checkSync = () => {
                    polls++;
                    const status = gl.clientWaitSync(sync!, 0, 0);
                    if (status === gl.TIMEOUT_EXPIRED) {
                        this.syncTimeout = setTimeout(checkSync);
                        return;
                    }
                    if (status === gl.WAIT_FAILED) fail('clientWaitSync reported WAIT_FAILED');
                    this.distanceLifecycle?.fenceWaitEnd?.(performance.now(), polls);
                    this.syncTimeout = null;
                    gl.deleteSync(sync!);
                    const vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
                    gl.bindVertexArray(this.distanceVao);
                    this.distanceLifecycle?.readbackStart?.(performance.now());
                    gl.bindBuffer(gl.ARRAY_BUFFER, this.distanceBuffer);
                    gl.getBufferSubData(gl.ARRAY_BUFFER, 0, outComputedDistances);
                    gl.bindBuffer(gl.ARRAY_BUFFER, null);
                    this.distanceLifecycle?.readbackEnd?.(performance.now());
                    if (vao) gl.bindVertexArray(vao);
                    this.stats.distanceRuns++;
                    this.stats.lastDistanceMs = performance.now() - started;
                    resolve();
                };
                this.syncTimeout = setTimeout(checkSync);
            });

            if (previousProgram && previousProgramDeleted !== true) gl.useProgram(previousProgram);
            if (previousVao) gl.bindVertexArray(previousVao);
            return promise;
        };
    })();

    dispose(): void {
        const gl = this.gl;
        if (this.syncTimeout) { clearTimeout(this.syncTimeout); this.syncTimeout = null; }
        if (gl) {
            if (this.distanceProgram) gl.deleteProgram(this.distanceProgram);
            if (this.distanceVao) gl.deleteVertexArray(this.distanceVao);
            if (this.distanceBuffer) gl.deleteBuffer(this.distanceBuffer);
            if (this.distanceTf) gl.deleteTransformFeedback(this.distanceTf);
        }
        this.distanceProgram = null;
        this.distanceVao = null;
        this.distanceBuffer = null;
        this.distanceTf = null;
        this.distanceLocs = null;
        this.quadMaterial?.dispose?.();
        this.target?.dispose?.();
        this.target = null;
        this.quadScene = null;
        this.quadMaterial = null;
        this.layout = null;
    }
}
