import { describe, expect, beforeAll, afterAll, test, afterEach, beforeEach, vi } from 'vitest';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AwsStub, mockClient } from 'aws-sdk-client-mock';
import { sdkStreamMixin } from '@smithy/util-stream';
import { Readable } from 'stream';
import fetchMock from '@fetch-mock/vitest';
import { fs, vol } from 'memfs';

import { withSearchIndex } from '../withSearchIndex';

declare var process: {
  env: {
    MOSAIC_S3_BUCKET?: string;
    MOSAIC_S3_REGION?: string;
    MOSAIC_S3_ACCESS_KEY_ID?: string;
    MOSAIC_S3_SECRET_ACCESS_KEY?: string;
    MOSAIC_SNAPSHOT_DIR?: string;
  };
};

vi.mock('fs', () => ({
  default: fs
}));

vi.mock('fs/promises', () => ({ default: fs.promises }));

describe('GIVEN withSearchIndex', () => {
  describe('WHEN snapshot-s3 Mosaic mode is set', () => {
    let savedEnv = process.env;
    let s3ClientMock: AwsStub<{}, { $metadata: {} }>;
    beforeAll(() => {
      process.env = {
        ...process.env,
        MOSAIC_S3_BUCKET: 'some-bucket',
        MOSAIC_S3_REGION: 'some-region',
        MOSAIC_S3_ACCESS_KEY_ID: 'some-access-key',
        MOSAIC_S3_SECRET_ACCESS_KEY: 'some-secret-key'
      };
      s3ClientMock = mockClient(S3Client);
      const indexStream = new Readable();
      indexStream.push('{ "someValue": true }');
      indexStream.push(null); // end of stream
      const indexContentStream = sdkStreamMixin(indexStream);
      s3ClientMock
        .on(GetObjectCommand, {
          Bucket: 'some-bucket',
          Key: 'search-data-condensed.json'
        })
        .resolves({ Body: indexContentStream });
      s3ClientMock
        .on(HeadObjectCommand, {
          Bucket: 'some-bucket',
          Key: 'search-data-condensed.json'
        })
        .resolvesOnce({ $metadata: { httpStatusCode: 200 } })
        .resolves({ $metadata: { httpStatusCode: 404 } });
      const configStream = new Readable();
      configStream.push('{ "someConfigValue": true }');
      configStream.push(null); // end of stream
      const configContentStream = sdkStreamMixin(configStream);
      s3ClientMock
        .on(GetObjectCommand, {
          Bucket: 'some-bucket',
          Key: 'search-config.json'
        })
        .resolves({ Body: configContentStream });
      s3ClientMock
        .on(HeadObjectCommand, {
          Bucket: 'some-bucket',
          Key: 'search-config.json'
        })
        .resolvesOnce({ $metadata: { httpStatusCode: 200 } })
        .resolves({ $metadata: { httpStatusCode: 404 } });
    });
    afterAll(() => {
      process.env = savedEnv;
      s3ClientMock.reset();
    });
    test('THEN search-index can be loaded from an S3 bucket', async () => {
      // arrange
      const content = await withSearchIndex({
        resolvedUrl: '/mynamespace/mypage.mdx',
        res: {
          getHeader: name => (name === 'X-Mosaic-Content-Url' ? '/mynamespace' : 'snapshot-s3')
        }
      });
      // assert
      expect(content).toEqual({
        props: { searchConfig: { someConfigValue: true }, searchIndex: { someValue: true } }
      });
    });
    test('THEN does not throw for a non-existent search-index', async () => {
      // arrange
      const content = await withSearchIndex({
        resolvedUrl: '/non-existent/mypage.mdx',
        res: {
          getHeader: name => (name === 'X-Mosaic-Content-Url' ? '/mynamespace' : 'snapshot-s3')
        }
      });
      // assert
      expect(content).toEqual({ props: {} });
    });
  });

  describe('WHEN snapshot-file Mosaic mode is set', () => {
    let savedEnv = process.env;
    beforeEach(() => {
      process.env = { MOSAIC_SNAPSHOT_DIR: '/some/snapshots' };
    });
    afterEach(() => {
      process.env = savedEnv;
    });
    test('THEN reads search-index from a local file', async () => {
      // arrange
      vol.fromNestedJSON({
        'some/snapshots/': {
          'search-data-condensed.json': '{ "someValue": true }',
          'search-config.json': '{ "someConfigValue": true }'
        }
      });
      const content = await withSearchIndex({
        resolvedUrl: '/mynamespace/mydir/mypage.mdx',
        res: {
          getHeader: name => (name === 'X-Mosaic-Content-Url' ? '/mydomain' : 'snapshot-file')
        }
      });
      expect(content).toEqual({
        props: { searchConfig: { someConfigValue: true }, searchIndex: { someValue: true } }
      });
      vol.reset();
    });
    test('THEN does not throw for a non-existent search-index', async () => {
      // arrange
      const content = await withSearchIndex({
        resolvedUrl: '/mynamespace/non-existent/mypage.mdx',
        res: {
          getHeader: name => (name === 'X-Mosaic-Content-Url' ? '/mydomain' : 'snapshot-file')
        }
      });
      console.log({ content });
      expect(content).toEqual({ props: {} });
    });
  });

  describe('WHEN active Mosaic mode is set', () => {
    beforeAll(() => {
      fetchMock.mockGlobal();
      fetchMock
        .once('*', JSON.stringify({ someValue: true }))
        .once('*', JSON.stringify({ someConfigValue: true }))
        .once('*', 404)
        .once('*', 404);
    });
    afterAll(() => {
      fetchMock.unmockGlobal();
    });
    test('THEN search-index is fetched from the data source', async () => {
      // arrange
      const content = await withSearchIndex({
        resolvedUrl: '/mynamespace/mypage.mdx',
        res: { getHeader: name => (name === 'X-Mosaic-Content-Url' ? '/mydomain' : 'active') }
      });
      // assert
      expect(content).toEqual({
        props: { searchConfig: { someConfigValue: true }, searchIndex: { someValue: true } }
      });
    });
    test('THEN does not throw for a non-existent search-index', async () => {
      // arrange
      const content = await withSearchIndex({
        resolvedUrl: '/mynamespace/non-existent/mypage.mdx',
        res: { getHeader: name => (name === 'X-Mosaic-Content-Url' ? '/mydomain' : 'active') }
      });
      // assert
      expect(content).toEqual({ props: {} });
    });
  });
});
