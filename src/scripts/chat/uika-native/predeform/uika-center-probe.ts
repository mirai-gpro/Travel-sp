// UIKA Native Runtime v1.1 — Gate 4B-2A Diagnostic C
//
// Reads the animated centre XYZ straight out of the GPU, by three routes, so that the
// pre-deformed texture can be compared against what the production path actually
// produces rather than only against a CPU reference:
//
//   production-attribute   the production distance shader's route: the canonical centre
//                          arrives as a vertex attribute from SplatMesh's centres buffer,
//                          the 51 channels are summed in the vertex stage
//   production-texture     the same vertex stage, but the canonical centre is fetched
//                          from centersColorsTexture the way the render shader fetches it
//   predeform              the RGBA32F texture written by the fragment-stage pass
//
// Comparing the first two isolates the centre's data path; comparing either against the
// third isolates the shader stage. Nothing here asserts a cause.
//
// The expression itself — the two helper functions and the accumulation loop — is copied
// verbatim from the production shaders, so the arithmetic being compared is the same
// arithmetic in every route.

function fail(message: string): never {
    throw new Error(`UIKA centre probe: ${message}`);
}

const HELPERS = /* glsl */`
vec3 uikaBasisDelta(in int channel, in uint sIndex) {
    float d = float(sIndex + uint(uikaGaussianCount * channel)) / uikaBasisTextureSize.x;
    vec2 uv = vec2(fract(d), floor(d) / uikaBasisTextureSize.y);
    return uintBitsToFloat(texture(uikaBasisTexture, uv).rgb);
}

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
`;

const UNIFORMS = /* glsl */`
uniform highp usampler2D uikaBasisTexture;
uniform vec2 uikaBasisTextureSize;
uniform highp usampler2D uikaWeightTexture;
uniform vec2 uikaWeightTextureSize;
uniform int uikaBasisCount;
uniform int uikaGaussianCount;
`;

/** The production distance shader's route, emitting xyz instead of the dot product. */
const VS_ATTRIBUTE = /* glsl */`#version 300 es
precision highp float;
precision highp int;
in vec4 center;
${UNIFORMS}
flat out vec3 animatedCenterOut;
${HELPERS}
void main(void) {
    vec3 animatedCenter = center.xyz;
    uint sIndex = uint(gl_VertexID);
    for (int k = 0; k < uikaBasisCount; ++k) {
        animatedCenter += uikaWeight(k) * uikaBasisDelta(k, sIndex);
    }
    animatedCenterOut = animatedCenter;
}
`;

/** The same vertex stage, with the render shader's centre fetch. */
const VS_TEXTURE = /* glsl */`#version 300 es
precision highp float;
precision highp int;
uniform highp usampler2D centersColorsTexture;
uniform vec2 centersColorsTextureSize;
${UNIFORMS}
flat out vec3 animatedCenterOut;
${HELPERS}
vec2 getCenterUV(in uint sIndex) {
    vec2 samplerUV = vec2(0.0, 0.0);
    float d = float(sIndex * uint(1) + uint(0)) / centersColorsTextureSize.x;
    samplerUV.y = float(floor(d)) / centersColorsTextureSize.y;
    samplerUV.x = fract(d);
    return samplerUV;
}
void main(void) {
    uint sIndex = uint(gl_VertexID);
    uvec4 sampledCenterColor = texture(centersColorsTexture, getCenterUV(sIndex));
    vec3 animatedCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));
    for (int k = 0; k < uikaBasisCount; ++k) {
        animatedCenter += uikaWeight(k) * uikaBasisDelta(k, sIndex);
    }
    animatedCenterOut = animatedCenter;
}
`;

const FS = /* glsl */`#version 300 es
precision lowp float;
out vec4 fragColor;
void main(){}
`;

export type UikaCenterProbeRoute = 'production-attribute' | 'production-texture';

interface ProbeProgram {
    program: WebGLProgram;
    vao: WebGLVertexArrayObject;
    tf: WebGLTransformFeedback;
    out: WebGLBuffer;
    centerLoc: number;
    locs: Record<string, WebGLUniformLocation | null>;
}

export class UikaCenterProbe {
    private gl: WebGL2RenderingContext;
    private programs = new Map<UikaCenterProbeRoute, ProbeProgram>();

    constructor(
        private readonly renderer: any,
        private readonly splatMesh: any,
    ) {
        this.gl = renderer.getContext();
    }

    private glTexture(texture: any, what: string): WebGLTexture {
        const properties = this.renderer.properties;
        if (!properties || typeof properties.get !== 'function') {
            fail('three.js renderer.properties is not reachable');
        }
        const entry = properties.get(texture);
        if (!entry || !entry.__webglTexture) fail(`${what} has no GL name yet`);
        return entry.__webglTexture as WebGLTexture;
    }

    private build(route: UikaCenterProbeRoute): ProbeProgram {
        const existing = this.programs.get(route);
        if (existing) return existing;
        const gl = this.gl;
        const source = route === 'production-attribute' ? VS_ATTRIBUTE : VS_TEXTURE;

        const compile = (type: number, src: string): WebGLShader => {
            const shader = gl.createShader(type);
            if (!shader) fail('could not create a shader object');
            gl.shaderSource(shader!, src);
            gl.compileShader(shader!);
            if (!gl.getShaderParameter(shader!, gl.COMPILE_STATUS)) {
                const log = gl.getShaderInfoLog(shader!);
                gl.deleteShader(shader!);
                fail(`${route} shader failed to compile: ${log}`);
            }
            return shader!;
        };

        const program = gl.createProgram();
        if (!program) fail('could not create a program');
        gl.attachShader(program, compile(gl.VERTEX_SHADER, source));
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FS));
        gl.transformFeedbackVaryings(program, ['animatedCenterOut'], gl.SEPARATE_ATTRIBS);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            fail(`${route} program failed to link: ${gl.getProgramInfoLog(program)}`);
        }

        const count = this.splatMesh.getSplatCount();
        const out = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, out);
        gl.bufferData(gl.ARRAY_BUFFER, count * 3 * 4, gl.STATIC_READ);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        const built: ProbeProgram = {
            program,
            vao: gl.createVertexArray()!,
            tf: gl.createTransformFeedback()!,
            out: out!,
            centerLoc: route === 'production-attribute' ? gl.getAttribLocation(program, 'center') : -1,
            locs: {
                basisTexture: gl.getUniformLocation(program, 'uikaBasisTexture'),
                basisTextureSize: gl.getUniformLocation(program, 'uikaBasisTextureSize'),
                weightTexture: gl.getUniformLocation(program, 'uikaWeightTexture'),
                weightTextureSize: gl.getUniformLocation(program, 'uikaWeightTextureSize'),
                basisCount: gl.getUniformLocation(program, 'uikaBasisCount'),
                gaussianCount: gl.getUniformLocation(program, 'uikaGaussianCount'),
                centersColorsTexture: gl.getUniformLocation(program, 'centersColorsTexture'),
                centersColorsTextureSize: gl.getUniformLocation(program, 'centersColorsTextureSize'),
            },
        };
        this.programs.set(route, built);
        return built;
    }

    /** Float32Array of 3 * gaussianCount animated centre components, straight from the GPU. */
    read(route: UikaCenterProbeRoute): Float32Array {
        const gl = this.gl;
        const mesh = this.splatMesh;
        const p = this.build(route);
        const count = mesh.getSplatCount();

        const previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
        const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM);
        const previousActive = gl.getParameter(gl.ACTIVE_TEXTURE);
        gl.activeTexture(gl.TEXTURE0);
        const previousUnit0 = gl.getParameter(gl.TEXTURE_BINDING_2D);
        gl.activeTexture(gl.TEXTURE1);
        const previousUnit1 = gl.getParameter(gl.TEXTURE_BINDING_2D);
        gl.activeTexture(gl.TEXTURE2);
        const previousUnit2 = gl.getParameter(gl.TEXTURE_BINDING_2D);

        gl.bindVertexArray(p.vao);
        gl.useProgram(p.program);
        gl.enable(gl.RASTERIZER_DISCARD);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.glTexture(mesh.uikaBasisTexture, 'the basis texture'));
        gl.uniform1i(p.locs.basisTexture, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.glTexture(mesh.uikaWeightTexture, 'the weight texture'));
        gl.uniform1i(p.locs.weightTexture, 1);
        gl.uniform2f(p.locs.basisTextureSize, mesh.uikaBasisTextureSize.x, mesh.uikaBasisTextureSize.y);
        gl.uniform2f(p.locs.weightTextureSize, mesh.uikaWeightTextureSize.x, mesh.uikaWeightTextureSize.y);
        gl.uniform1i(p.locs.basisCount, mesh.uikaBasisCount);
        gl.uniform1i(p.locs.gaussianCount, mesh.uikaGaussianCount);

        if (route === 'production-attribute') {
            const centersBuffer = mesh.distancesTransformFeedback?.centersBuffer;
            if (!centersBuffer) {
                fail('SplatMesh has no centres buffer, so the production attribute route '
                    + 'cannot be read; the production distance pass must have run once');
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, centersBuffer);
            gl.enableVertexAttribArray(p.centerLoc);
            gl.vertexAttribPointer(p.centerLoc, 4, gl.FLOAT, false, 0, 0);
        } else {
            const u = mesh.material.uniforms;
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, this.glTexture(u.centersColorsTexture.value, 'the centres texture'));
            gl.uniform1i(p.locs.centersColorsTexture, 2);
            gl.uniform2f(p.locs.centersColorsTextureSize,
                         u.centersColorsTextureSize.value.x, u.centersColorsTextureSize.value.y);
        }

        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, p.tf);
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, p.out);
        gl.beginTransformFeedback(gl.POINTS);
        gl.drawArrays(gl.POINTS, 0, count);
        gl.endTransformFeedback();
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
        gl.disable(gl.RASTERIZER_DISCARD);

        const out = new Float32Array(count * 3);
        gl.bindBuffer(gl.ARRAY_BUFFER, p.out);
        gl.getBufferSubData(gl.ARRAY_BUFFER, 0, out);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        // Put three.js's texture-unit cache back exactly as it was.
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, previousUnit0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, previousUnit1);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, previousUnit2);
        gl.activeTexture(previousActive);
        if (previousProgram) gl.useProgram(previousProgram);
        if (previousVao) gl.bindVertexArray(previousVao);
        return out;
    }

    dispose(): void {
        const gl = this.gl;
        for (const p of this.programs.values()) {
            gl.deleteProgram(p.program);
            gl.deleteVertexArray(p.vao);
            gl.deleteTransformFeedback(p.tf);
            gl.deleteBuffer(p.out);
        }
        this.programs.clear();
    }
}
