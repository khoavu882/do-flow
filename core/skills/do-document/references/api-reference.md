# API Reference Template
# Use this template for generating high-quality API documentation.

## 🚀 [Endpoint Name]
`METHOD /path/to/endpoint`

### Description
Clear, one-sentence description of what the endpoint does.

### Request
- **Headers**: `Content-Type: application/json`, `Authorization: Bearer <token>`
- **Path Parameters**:
  - `id` (string): The unique identifier of the resource.
- **Query Parameters**:
  - `limit` (int, optional): Number of items to return.
- **Body**:
  ```json
  {
    "field": "value"
  }
  ```

### Response
- **Success (200 OK)**:
  ```json
  {
    "status": "success",
    "data": { ... }
  }
  ```
- **Error (400 Bad Request)**:
  ```json
  {
    "error": "INVALID_INPUT",
    "message": "The field X is required."
  }
  ```

### Usage Example
```bash
curl -X POST https://api.example.com/v1/endpoint -d '{"field": "value"}'
```
