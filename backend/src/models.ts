import mongoose, { Schema, model, type InferSchemaType } from 'mongoose';

export type Role = 'viewer' | 'editor' | 'admin';

const userSchema = new Schema(
  {
    _id: { type: String, required: true },
    username: { type: String, required: true, unique: true, index: true },
    avatar: { type: String, default: '' },
    join_date: { type: Date, required: true, default: Date.now },
    role: {
      type: String,
      enum: ['viewer', 'editor', 'admin'],
      required: true,
      default: 'editor'
    }
  },
  { versionKey: false }
);

const projectSchema = new Schema(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    created_at: { type: Date, required: true, default: Date.now },
    updated_at: { type: Date, required: true, default: Date.now },
    permissions: {
      type: Map,
      of: String,
      default: {}
    }
  },
  { versionKey: false }
);

const fileSchema = new Schema(
  {
    _id: { type: String, required: true },
    project_id: { type: String, required: true, index: true },
    path: { type: String, required: true },
    content: { type: String, required: true }
  },
  { versionKey: false }
);

const suggestionSchema = new Schema(
  {
    _id: { type: String, required: true },
    project_id: { type: String, required: true, index: true },
    file_id: { type: String, required: true, index: true },
    creator_id: { type: String, required: true, index: true },
    text: { type: String, required: true },
    votes: { type: Map, of: Number, default: {} }
  },
  { versionKey: false }
);

export type UserRecord = InferSchemaType<typeof userSchema>;
export type ProjectRecord = InferSchemaType<typeof projectSchema>;
export type FileRecord = InferSchemaType<typeof fileSchema>;
export type SuggestionRecord = InferSchemaType<typeof suggestionSchema>;

export const UserModel = mongoose.models.User || model('User', userSchema);
export const ProjectModel = mongoose.models.Project || model('Project', projectSchema);
export const FileModel = mongoose.models.File || model('File', fileSchema);
export const SuggestionModel =
  mongoose.models.Suggestion || model('Suggestion', suggestionSchema);
