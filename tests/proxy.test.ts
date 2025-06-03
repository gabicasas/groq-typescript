import Groq from '../src/index';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as fs from 'fs'; // Node.js file system module
import * as path from 'path'; // Node.js path module

// Mock HttpsProxyAgent: jest.mock will hoist this call
jest.mock('https-proxy-agent');
const MockHttpsProxyAgent = HttpsProxyAgent as jest.MockedClass<typeof HttpsProxyAgent>;
const mockAgentInstance = { _isMockHttpsProxyAgent: true }; // Marker for identifying mock agent instances

// Mock fs module
jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

// Mock path module
const actualPath = jest.requireActual('path'); // To use actual path.join for test consistency
jest.mock('path', () => ({
  ...actualPath, // Retain other path functionalities
  resolve: jest.fn(), // Mock only path.resolve
}));
const mockPathResolve = path.resolve as jest.MockedFunction<typeof path.resolve>;

// Global fetch mock, to intercept outgoing requests
const mockFetch = jest.fn();

// A reusable valid proxy configuration object for tests
const validProxyConfigPayload = {
  proxies: [
    { host: 'proxy1.example.com', port: 8080, apiKey: 'key1' },
    { host: 'proxy2.example.com', port: 8081, auth: { username: 'user', password: 'pass' }, apiKey: 'key2' },
  ],
};

describe('Groq Client with Proxy Configuration', () => {
  beforeEach(() => {
    jest.resetAllMocks(); // Clear all mocks before each test

    // Configure the HttpsProxyAgent mock constructor to return our marker object
    MockHttpsProxyAgent.mockImplementation(() => mockAgentInstance as any);

    // Set up a default successful response for fetch
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ id: 'chatcmpl-mock-id', choices: [{ message: { content: 'mock response' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    global.fetch = mockFetch; // Assign the mock to global fetch

    // Default mock for path.resolve to simulate a fixed project root
    mockPathResolve.mockReturnValue(actualPath.join('/fake', 'project', 'root', 'groq-proxies.json'));
    // Default fs.existsSync to false (file not found)
    mockFs.existsSync.mockReturnValue(false);
  });

  // Helper function to easily set up the proxy configuration file mock
  const setupProxyConfigFile = (content: object | string | null) => {
    if (content === null) {
      mockFs.existsSync.mockReturnValue(false); // Simulate file not existing
    } else {
      mockFs.existsSync.mockReturnValue(true); // Simulate file exists
      // Simulate reading file content (either raw string for malformed JSON, or stringified object)
      mockFs.readFileSync.mockReturnValue(typeof content === 'string' ? content : JSON.stringify(content));
    }
  };

  it('should load valid proxy config, use it, and rotate proxies', async () => {
    setupProxyConfigFile(validProxyConfigPayload);
    const client = new Groq({ apiKey: 'defaultKey_unused_for_this_test' });

    // First API call
    await client.chat.completions.create({ messages: [{role: 'user', content: 'req1'}], model: 'llama3-8b-8192' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    let request = mockFetch.mock.calls[0][0] as Request;
    let requestOptions = mockFetch.mock.calls[0][1] as RequestInit;
    expect(request.headers.get('Authorization')).toBe('Bearer key1');
    expect(MockHttpsProxyAgent).toHaveBeenCalledWith('http://proxy1.example.com:8080');
    expect(requestOptions.agent).toBe(mockAgentInstance);

    // Second API call
    await client.chat.completions.create({ messages: [{role: 'user', content: 'req2'}], model: 'llama3-8b-8192' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    request = mockFetch.mock.calls[1][0] as Request;
    requestOptions = mockFetch.mock.calls[1][1] as RequestInit;
    expect(request.headers.get('Authorization')).toBe('Bearer key2');
    expect(MockHttpsProxyAgent).toHaveBeenCalledWith('http://user:pass@proxy2.example.com:8081');
    expect(requestOptions.agent).toBe(mockAgentInstance);

    // Third API call (tests rotation back to the first proxy)
    await client.chat.completions.create({ messages: [{role: 'user', content: 'req3'}], model: 'llama3-8b-8192' });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    request = mockFetch.mock.calls[2][0] as Request;
    requestOptions = mockFetch.mock.calls[2][1] as RequestInit;
    expect(request.headers.get('Authorization')).toBe('Bearer key1');
    expect(MockHttpsProxyAgent).toHaveBeenCalledWith('http://proxy1.example.com:8080'); // Back to proxy1
    expect(requestOptions.agent).toBe(mockAgentInstance);
  });

  it('should use default API key and no proxy if config file is missing', async () => {
    setupProxyConfigFile(null); // File does not exist
    const client = new Groq({ apiKey: 'defaultKey' });

    await client.chat.completions.create({ messages: [{role: 'user', content: 'test'}], model: 'llama3-8b-8192' });
    const request = mockFetch.mock.calls[0][0] as Request;
    const requestOptions = mockFetch.mock.calls[0][1] as RequestInit;
    expect(request.headers.get('Authorization')).toBe('Bearer defaultKey');
    expect(MockHttpsProxyAgent).not.toHaveBeenCalled();
    if (requestOptions.agent) { // Agent might be the default keep-alive agent
        expect(requestOptions.agent).not.toBe(mockAgentInstance);
    }
  });

  it('should use default API key if "proxies" array is empty in config file', async () => {
    setupProxyConfigFile({ proxies: [] }); // Valid JSON, but empty proxies list
    const client = new Groq({ apiKey: 'defaultKey' });

    await client.chat.completions.create({ messages: [{role: 'user', content: 'test'}], model: 'llama3-8b-8192' });
    expect(mockFetch.mock.calls[0][0].headers.get('Authorization')).toBe('Bearer defaultKey');
    expect(MockHttpsProxyAgent).not.toHaveBeenCalled();
  });

  it('should use default API key if config file contains malformed JSON', async () => {
    setupProxyConfigFile("this is not valid json { malformed: true "); // Malformed content
    const client = new Groq({ apiKey: 'defaultKey' });

    await client.chat.completions.create({ messages: [{role: 'user', content: 'test'}], model: 'llama3-8b-8192' });
    expect(mockFetch.mock.calls[0][0].headers.get('Authorization')).toBe('Bearer defaultKey');
    expect(MockHttpsProxyAgent).not.toHaveBeenCalled();
  });

  it('should filter out invalid proxy entries and use only valid ones', async () => {
    setupProxyConfigFile({
      proxies: [
        { host: 'validproxy.com', port: 80, apiKey: 'validKey1' }, // Valid
        { port: 1234, apiKey: 'keyForProxyWithMissingHost' },       // Invalid (missing host)
        { host: 'noApiKeyProxy.com', port: 8080 },                 // Invalid (missing apiKey)
        { host: 'validproxy2.com', port: 81, apiKey: 'validKey2', auth: {username: 'user2'} }, // Valid
      ],
    });
    const client = new Groq({ apiKey: 'defaultKey_unused_here' });

    // First call uses 'validproxy.com'
    await client.chat.completions.create({ messages: [{role: 'user', content: 'req1'}], model: 'llama3-8b-8192' });
    expect(mockFetch.mock.calls[0][0].headers.get('Authorization')).toBe('Bearer validKey1');
    expect(MockHttpsProxyAgent).toHaveBeenLastCalledWith('http://validproxy.com:80');

    // Second call uses 'validproxy2.com' (skips the two invalid entries)
    await client.chat.completions.create({ messages: [{role: 'user', content: 'req2'}], model: 'llama3-8b-8192' });
    expect(mockFetch.mock.calls[1][0].headers.get('Authorization')).toBe('Bearer validKey2');
    expect(MockHttpsProxyAgent).toHaveBeenLastCalledWith('http://user2@validproxy2.com:81');

    // Third call rotates back to 'validproxy.com'
    await client.chat.completions.create({ messages: [{role: 'user', content: 'req3'}], model: 'llama3-8b-8192' });
    expect(mockFetch.mock.calls[2][0].headers.get('Authorization')).toBe('Bearer validKey1');
    expect(MockHttpsProxyAgent).toHaveBeenLastCalledWith('http://validproxy.com:80');
  });

  it('should not load proxy config if process.versions.node is null (simulating non-Node.js)', async () => {
    const originalProcess = global.process;
    // @ts-ignore - Modifying global.process for test purposes
    global.process = { ...originalProcess, versions: { ...originalProcess.versions, node: null } };

    setupProxyConfigFile(validProxyConfigPayload); // Proxy file is present and valid
    const client = new Groq({ apiKey: 'defaultKey' });

    await client.chat.completions.create({ messages: [{role: 'user', content: 'test'}], model: 'llama3-8b-8192' });
    expect(mockFetch.mock.calls[0][0].headers.get('Authorization')).toBe('Bearer defaultKey');
    expect(MockHttpsProxyAgent).not.toHaveBeenCalled();

    global.process = originalProcess; // Restore global.process
  });

  it('should correctly construct proxy URL for auth with username only', async () => {
      setupProxyConfigFile({
          proxies: [{ host: 'authproxy.com', port: 80, auth: { username: 'useronly' }, apiKey: 'authKey' }]
      });
      const client = new Groq({ apiKey: 'defaultKey_unused_here' });
      await client.chat.completions.create({ messages: [{role: 'user', content: 'test'}], model: 'llama3-8b-8192' });

      expect(MockHttpsProxyAgent).toHaveBeenCalledWith('http://useronly@authproxy.com:80');
      expect(mockFetch.mock.calls[0][0].headers.get('Authorization')).toBe('Bearer authKey');
  });

  it('should correctly construct proxy URL for auth with special characters in username/password', async () => {
      setupProxyConfigFile({
          proxies: [{ host: 'specialproxy.com', port: 88, auth: { username: 'user@name', password: 'p@s&w ord' }, apiKey: 'specialKey' }]
      });
      const client = new Groq({ apiKey: 'defaultKey_unused_here' });
      await client.chat.completions.create({ messages: [{role: 'user', content: 'test'}], model: 'llama3-8b-8192' });

      const expectedProxyUrl = `http://${encodeURIComponent('user@name')}:${encodeURIComponent('p@s&w ord')}@specialproxy.com:88`;
      expect(MockHttpsProxyAgent).toHaveBeenCalledWith(expectedProxyUrl);
      expect(mockFetch.mock.calls[0][0].headers.get('Authorization')).toBe('Bearer specialKey');
  });
});
